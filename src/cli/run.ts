import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveAgentRunner } from "../agent/resolve.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { discoverRuntimeConfig, loadProfileByConvention, slugForCwd } from "../config/discover.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { runTicket } from "../daemon/run-ticket.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { assertSlackConfigured } from "../integrations/notifier.ts";
import type { AnalyticsClient } from "../telemetry/analytics/client.ts";
import { type Analytics, createAnalytics } from "../telemetry/analytics/index.ts";
import { stdoutSink } from "../telemetry/emit.ts";
import { buildSummary } from "../telemetry/emitter.ts";
import type { TelemetryEvent } from "../telemetry/events.ts";
import { EXIT, StyreError, errorKindForExit, toolchainError, usageError } from "./errors.ts";
import { guard } from "./output.ts";
import { finishRunResult, parkDir } from "./park.ts";
import { formatMissingTools, preflightToolchain } from "./preflight.ts";

/** Exit codes this command can produce: 0 success · 1 operational stop (blocked/no-progress) ·
 *  64 usage · 65 resume-refused · 69 toolchain missing · 70 internal · 75 parked · 78 config.
 *  See `./errors.ts` `EXIT` for the shared, cross-command scheme. */

const MUST_HAVE = ["build", "test", "check"] as const;

/** Assert that every component's must-have commands are resolved (either a string command or
 *  `{ unavailable: true }`). Throws if any are undefined (absent) — the unresolved state that
 *  indicates setup was not run or was incomplete. */
export function assertResolved(profile: Profile): void {
  for (const c of profile.components) {
    for (const k of MUST_HAVE) {
      const v = c.commands[k];
      if (v === undefined) {
        throw new Error(
          `profile component '${c.name}' has an unresolved '${k}' command — re-run \`styre setup\`.`,
        );
      }
    }
  }
}

/** Hand-written args shape for `runImpl` — citty's inferred `args` type from the inline `args:`
 *  literal below isn't nameable outside it, and a `Parameters<typeof runCommand.run>` shortcut is
 *  circular (the command references `runImpl` which would need the command's own type). */
export interface RunArgs {
  ticket?: string;
  profile?: string;
  slug?: string;
  config?: string;
  db?: string;
  resume?: string;
  "accept-head"?: boolean;
  inspect?: boolean;
  "in-place"?: boolean;
}

export const runCommand = defineCommand({
  meta: { name: "run", description: "Ingest one ticket and drive it to PR-ready, then exit." },
  args: {
    ticket: { type: "positional", required: false, description: "Ticket ref (e.g. ENG-123)" },
    profile: {
      type: "string",
      description:
        "Path to the project-profile JSON (default: ~/.config/styre/<slug>/profile.json for the cwd repo)",
    },
    slug: {
      type: "string",
      description:
        "Project slug to locate the profile + per-project config (default: derived from the cwd repo)",
    },
    config: { type: "string", description: "Path to a runtime config.json (optional)" },
    db: { type: "string", description: "DB path (default: a fresh per-run temp DB)" },
    resume: { type: "string", description: "Resume a parked run by ticket ident" },
    "accept-head": {
      type: "boolean",
      description: "Resume even though the branch HEAD moved (drops carryover)",
    },
    inspect: { type: "boolean", description: "Print resume diagnostics and exit without running" },
    "in-place": {
      type: "boolean",
      description:
        "Work on a branch in the repo root instead of a worktree (disposable single-use checkout only)",
    },
  },
  run: (ctx) => guard("run", () => runImpl({ args: ctx.args as unknown as RunArgs })),
});

export async function runImpl(
  { args }: { args: RunArgs },
  deps?: { analyticsClient?: AnalyticsClient },
): Promise<void> {
  // Hoisted so the single catch can emit `cliError` for throws that happen BEFORE analytics is
  // built (bad/absent profile, "not a git repo" usage error, config-discovery errors). When
  // config was never resolved, the catch builds a fallback client (env opt-outs still apply).
  let analytics: Analytics | undefined;
  try {
    let profile: Profile;
    let slug: string;
    if (args.profile && args.profile.length > 0) {
      profile = loadProfile(args.profile);
      slug = args.slug && args.slug.length > 0 ? args.slug : profile.slug;
    } else {
      const derived = args.slug && args.slug.length > 0 ? args.slug : slugForCwd();
      if (!derived) {
        throw usageError(
          "no --profile given and the current directory is not a git repo",
          "cd into the target repo, or pass --profile / --slug.",
        );
      }
      slug = derived;
      profile = loadProfileByConvention(slug);
    }
    assertResolved(profile);
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });
    assertSlackConfigured(runtimeConfig);
    if (runtimeConfig.notifier !== "none") {
      // human-readable status → stderr (stdout carries only NDJSON telemetry)
      process.stderr.write(
        `notifier: ${runtimeConfig.notifier} → ${runtimeConfig.slack?.channel} (policy: ${runtimeConfig.notify})\n`,
      );
    }

    const a = createAnalytics(runtimeConfig, { client: deps?.analyticsClient });
    analytics = a;
    const startedAt = Date.now();

    if (args["in-place"] && !(args.resume && args.resume.length > 0)) {
      const { discoverRepoRoot, assertInPlaceSafe, assertInPlaceIdentity } = await import(
        "../dispatch/in-place.ts"
      );
      // cwd git-toplevel; THROWS (fail-closed) if not a repo — never falls through to the stale profile path
      const discovered = discoverRepoRoot();
      if (discovered !== profile.targetRepo) {
        console.error(
          `IN-PLACE: discovered repo root ${discovered} differs from the profile's targetRepo ${profile.targetRepo}; using the discovered root (components/commands still come from the profile).`,
        );
      }
      profile.targetRepo = discovered;
      assertInPlaceSafe(profile.targetRepo);
      await assertInPlaceIdentity(profile.targetRepo, profile);
    }

    if (args.resume && args.resume.length > 0) {
      const { resumeRun } = await import("./park.ts");
      await resumeRun(
        { resume: args.resume, acceptHead: args["accept-head"], inspect: args.inspect },
        profile,
        runtimeConfig,
      );
      return;
    }

    if (!args.ticket || args.ticket.length === 0) {
      throw usageError(
        "--ticket is required when not using --resume",
        "Pass a ticket ref, e.g. styre run ENG-123.",
      );
    }

    // Fail fast before any spend if a program the components' commands need isn't installed on
    // this machine. Fresh-run path only — `--resume`/`--inspect` returned above (their re-running
    // ground-truth steps are the check, and `--inspect` must stay exit-0 on a tool-less machine).
    const missingTools = preflightToolchain(profile);
    if (missingTools.length > 0) {
      throw toolchainError(formatMissingTools(missingTools));
    }

    const dbPath =
      args.db && args.db.length > 0
        ? args.db
        : join(mkdtempSync(join(tmpdir(), "styre-run-")), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    recover(db, realRecoverDeps());

    const ports = makeProjectorPorts(runtimeConfig, profile);
    const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
    const runner = resolveAgentRunner(agentConfig);
    const registry = buildDispatchRegistry({
      runner,
      agentConfig,
      profile,
      worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
      inPlace: (args["in-place"] as boolean | undefined) ?? false,
    });

    a.runStarted({
      projectId: profile.analyticsId ?? "",
      resumed: false,
      tracker: runtimeConfig.issueTracker,
      forge: runtimeConfig.forge,
    });

    const out = await runTicket({
      db,
      profile,
      runtimeConfig,
      ports,
      registry,
      ticketRef: args.ticket,
      emit: stdoutSink,
    });

    a.runCompleted(
      buildSummary(db, out.ticketId, out) as Extract<TelemetryEvent, { type: "summary" }>,
      Date.now() - startedAt,
      {
        complexityGrading: runtimeConfig.complexityGrading,
        onPlanDefect: runtimeConfig.onPlanDefect,
      },
    );

    console.error(out.summary); // human summary → stderr; stdout carries only NDJSON telemetry
    const ident = getTicket(db, out.ticketId)?.ident ?? args.ticket;
    if (out.outcome === "parked" && out.park) {
      // Print resume-hint before finishRunResult (which does dumpPark + sets exitCode).
      // parkDir gives the path without touching the DB.
      const dir = parkDir(profile.slug, ident);
      console.error(
        `Parked: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
          `Resume with: styre run --resume ${ident} ${args.profile ? `--profile ${args.profile}` : `--slug ${slug}`}\n` +
          `Dump: ${dir}`,
      );
    }
    finishRunResult(db, dbPath, profile.slug, ident, out);
  } catch (err) {
    const code = err instanceof StyreError ? err.code : EXIT.INTERNAL;
    // If we threw before config was resolved, `analytics` is undefined — build a fallback so the
    // failure is still counted. `createAnalytics` honors DO_NOT_TRACK / STYRE_TELEMETRY, and
    // `cli_error` carries no PII. Assigning back to `analytics` lets the finally flush it.
    analytics ??= createAnalytics({ telemetry: true }, { client: deps?.analyticsClient });
    analytics.cliError({
      command: "run",
      exitCode: code,
      errorClass: err instanceof Error ? err.constructor.name : "Unknown",
      errorKind: errorKindForExit(code),
    });
    throw err; // rethrow → guard renders + sets process.exitCode
  } finally {
    await analytics?.shutdown();
  }
}
