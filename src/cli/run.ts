import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { resolveAgentRunner } from "../agent/resolve.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../config/runtime-config.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { runTicket } from "../daemon/run-ticket.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { createAnalytics } from "../telemetry/analytics/index.ts";
import { stdoutSink } from "../telemetry/emit.ts";
import { buildSummary } from "../telemetry/emitter.ts";
import type { TelemetryEvent } from "../telemetry/events.ts";
import { finishRunResult, parkDir } from "./park.ts";

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

export const runCommand = defineCommand({
  meta: { name: "run", description: "Ingest one ticket and drive it to PR-ready, then exit." },
  args: {
    ticket: { type: "positional", required: false, description: "Ticket ref (e.g. ENG-123)" },
    profile: { type: "string", required: true, description: "Path to the project-profile JSON" },
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
  async run({ args }) {
    const profile = loadProfile(args.profile);
    assertResolved(profile);
    const runtimeConfig =
      args.config && args.config.length > 0
        ? RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8")))
        : DEFAULT_RUNTIME_CONFIG;

    const analytics = createAnalytics(runtimeConfig);
    const startedAt = Date.now();
    try {
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
        throw new Error("run: --ticket is required when not using --resume");
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

      analytics.runStarted({
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

      analytics.runCompleted(
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
            `Resume with: styre run --resume ${ident} --profile ${args.profile}\n` +
            `Dump: ${dir}`,
        );
      }
      finishRunResult(db, dbPath, profile.slug, ident, out);
    } catch (err) {
      analytics.cliError({
        command: "run",
        exitCode: typeof process.exitCode === "number" ? process.exitCode : 1,
        errorClass: err instanceof Error ? err.constructor.name : "Unknown",
      });
      throw err;
    } finally {
      await analytics.shutdown();
    }
  },
});
