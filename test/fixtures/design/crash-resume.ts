// test/fixtures/design/crash-resume.ts
// Usage: bun test/fixtures/design/crash-resume.ts <spec.json>
// Resumes a paused design harness run (in place) with the real handlers and a scripted agent, and
// blocks at one crash point, writing <readyFile> first, so the parent test can SIGKILL this process:
//   before-commit    the step's handler returned; its success transaction has not run
//   after-commit     the step's success committed (seen at the start of the next step)
//   after-invalidate the step's invalidate transaction committed; the step is pending in its new
//                    generation and has not started (seen when advance.ts resolves its handler)
// XDG_STATE_HOME, XDG_CONFIG_HOME and TMPDIR come from the parent; no real agent runs. Bounded:
// it exits on its own after 60 s, or as soon as its parent is gone.
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { loadRunProfile } from "../../../src/cli/load-profile.ts";
import { resumeRun } from "../../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../../src/config/agent-config.ts";
import { discoverRuntimeConfig } from "../../../src/config/discover.ts";
import { type HandlerContext, StepRegistry } from "../../../src/daemon/step-registry.ts";
import { getByKey } from "../../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../../src/dispatch/handlers.ts";
import { fakeForge } from "../../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../../src/integrations/adapters/fake-issue-tracker.ts";
import { defaultScript, newCalls, scriptedRunner } from "../../helpers/design-script.ts";

interface CrashSpec {
  profilePath: string;
  configPath: string;
  ident: string;
  step: string;
  point: "before-commit" | "after-commit" | "after-invalidate";
  readyFile: string;
}
const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as CrashSpec;

/** Signal readiness, then wait for the parent's SIGKILL. Synchronous, so nothing else in this
 *  process runs meanwhile; never endless: it exits after 60 s, or when its parent is gone (the
 *  parent pid changes when the parent dies). */
function block(): never {
  writeFileSync(spec.readyFile, "ready");
  const parent = process.ppid;
  const until = Date.now() + 60_000;
  while (Date.now() < until && process.ppid === parent) Bun.sleepSync(100);
  process.exit(3);
}

class CrashRegistry extends StepRegistry {
  private ran = false;
  private db: Database | null = null;
  private ticketId = 0;
  /** The crashed step's generation when this process started driving the run. */
  private startGeneration: number | null = null;
  constructor(private readonly real: StepRegistry) {
    super((db, ticketId) => {
      real.synchronize(db, ticketId);
      this.db = db;
      this.ticketId = ticketId;
      this.startGeneration ??= getByKey(db, ticketId, spec.step)?.generation ?? 0;
      if (
        spec.point === "after-commit" &&
        this.ran &&
        getByKey(db, ticketId, spec.step)?.status === "succeeded"
      )
        block();
    });
  }
  override resolve(handlerKey: string) {
    // after-invalidate: advance.ts resolves the handler after the invalidate transaction committed
    // and before runStep marks the step running, and nothing writes in between (nextStepKey is
    // pure; prepareVerificationRetry writes only for suite steps). Here the step is pending in a
    // generation newer than the one it had when this process started.
    if (spec.point === "after-invalidate" && handlerKey === spec.step && this.db !== null) {
      const step = getByKey(this.db, this.ticketId, spec.step);
      if (step?.status === "pending" && step.generation > (this.startGeneration ?? 0)) block();
    }
    const h = this.real.resolve(handlerKey);
    if (!h) return h;
    return async (ctx: HandlerContext) => {
      const ours = ctx.step.step_key === spec.step;
      const result = await h(ctx);
      if (ours) this.ran = true;
      if (ours && spec.point === "before-commit") block();
      return result;
    };
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

const loaded = loadRunProfile({ profile: spec.profilePath });
const config = discoverRuntimeConfig({ explicitPath: spec.configPath, slug: loaded.slug });
await resumeRun(
  { resume: spec.ident },
  loaded.profile,
  config,
  {
    ports: {
      issueTracker: fakeIssueTracker({
        ticket: {
          ident: spec.ident,
          title: "Harness ticket",
          description: "Harness body",
          typeLabel: "Feature",
          externalId: "uuid-harness",
          url: null,
        },
      }),
      forge: fakeForge(),
    },
    preflight: () => ({ ok: true, version: null }),
    probe: () => true,
    buildRegistry: (resumeContext, wiring) =>
      new CrashRegistry(
        buildDispatchRegistry({
          runner: scriptedRunner(defaultScript({ ident: spec.ident }), newCalls()),
          agentConfig: DEFAULT_AGENT_CONFIG,
          ...wiring,
          resumeContext,
        }),
      ),
  },
  loaded.nonPrimary,
);
throw new Error(`crash-resume: the run ended without reaching ${spec.point} of ${spec.step}`);
