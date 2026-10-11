import { expect, test } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { currentStepKey } from "../../src/daemon/current-step.ts";
import { DESIGN_TABLE, type StepRow, isSnapshotInput } from "../../src/daemon/design-graph.ts";
import { type HandlerContext, StepRegistry } from "../../src/daemon/step-registry.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { defaultScript, newCalls, scriptedRunner } from "../helpers/design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

type Label = "ticket" | "profile" | "config";
/** Fields every handler may read: identity and routing of the ticket, not design inputs. `ident`
 *  names dispatches and the branch for every step (it is fixed for the run, E2). */
const INFRASTRUCTURE: Record<Label, ReadonlySet<string>> = {
  ticket: new Set(["id", "project_id", "ident", "stage", "branch_name", "branch_prefix"]),
  profile: new Set(),
  config: new Set(),
};

function recording<T extends object>(target: T, label: Label, reads: Map<string, Set<string>>): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const step = currentStepKey();
      if (step !== null && typeof prop === "string") {
        const seen = reads.get(step) ?? new Set<string>();
        seen.add(`${label}.${prop}`);
        reads.set(step, seen);
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
}

/** Wraps each handler so the ticket and config it receives are recording proxies. */
class RecordingRegistry extends StepRegistry {
  constructor(
    private readonly real: StepRegistry,
    private readonly reads: Map<string, Set<string>>,
  ) {
    super(real.synchronize);
  }
  override resolve(handlerKey: string) {
    const h = this.real.resolve(handlerKey);
    if (!h) return h;
    return (ctx: HandlerContext) =>
      h({
        ...ctx,
        ticket: recording(ctx.ticket, "ticket", this.reads),
        config: recording(ctx.config, "config", this.reads),
      });
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

async function readsOf(complexityGrading: boolean): Promise<Map<string, Set<string>>> {
  const t = makeDesignTicket({ config: { complexityGrading } });
  const reads = new Map<string, Set<string>>();
  const real = buildDispatchRegistry({
    runner: scriptedRunner(defaultScript(), newCalls()),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: recording(t.profile, "profile", reads),
    worktreeRoot: t.worktreeRoot,
  });
  await driveUntil(
    { ...t, registry: new RecordingRegistry(real, reads) },
    atStep("checks:dispatch"),
  );
  return reads;
}

const tableSteps = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

/** The reads a step made through the proxies that are design inputs, not infrastructure. */
function inputReads(reads: Map<string, Set<string>>, stepKey: string): string[] {
  return [...(reads.get(stepKey) ?? [])].filter((read) => {
    const [label, field] = read.split(".") as [Label, string];
    return !INFRASTRUCTURE[label].has(field);
  });
}

// Checked against the inputs the row declares for THIS grading value, not for any: with grading off
// design:size declares neither the ticket title nor the profile, and must not read them.
for (const grading of [false, true]) {
  test(
    `grading ${grading ? "on" : "off"}: no design handler reads a field the table does not declare for it (§8.10)`,
    async () => {
      const reads = await readsOf(grading);
      // Every table step ran and was recorded: an empty map would pass the check below vacuously.
      // Two units size the ticket full (FULL_TRACK_MIN_UNITS), so design:review runs either way.
      expect([...reads.keys()].sort()).toEqual(tableSteps.map((r) => r.stepKey).sort());
      const undeclared: string[] = [];
      for (const row of tableSteps) {
        const declared: readonly string[] = row.inputs({ complexityGrading: grading });
        for (const read of inputReads(reads, row.stepKey)) {
          if (!declared.includes(read)) undeclared.push(`${row.stepKey} reads ${read}`);
        }
      }
      expect(undeclared).toEqual([]);
    },
    STEP_TEST_TIMEOUT_MS,
  );

  test(
    `grading ${grading ? "on" : "off"}: every declared ticket, profile and config input is read by its step`,
    async () => {
      const reads = await readsOf(grading);
      expect([...reads.keys()].sort()).toEqual(tableSteps.map((r) => r.stepKey).sort());
      const missing: string[] = [];
      for (const row of tableSteps) {
        const seen = reads.get(row.stepKey) ?? new Set<string>(); // infrastructure included: ticket.ident is also an input
        for (const name of row.inputs({ complexityGrading: grading })) {
          // run.* come from the registry's deps, not the proxied objects; outputs (plan,
          // workUnits) are read through git or the accessors, which check themselves.
          if (!isSnapshotInput(name) || name.startsWith("run.")) continue;
          if (!seen.has(name)) missing.push(`${row.stepKey} never reads ${name}`);
        }
      }
      expect(missing).toEqual([]);
    },
    STEP_TEST_TIMEOUT_MS,
  );
}
