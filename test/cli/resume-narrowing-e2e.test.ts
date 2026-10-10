import { afterEach, expect, test } from "bun:test";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";

const harnesses: DesignHarness[] = [];
const make = (mode: "worktree" | "in-place", required: boolean): DesignHarness => {
  const h = new DesignHarness(mode);
  h.editProfile((p) => {
    (p.components as unknown[]).push({
      name: "lib",
      kind: "ruby",
      paths: ["vendor-lib/**"],
      commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
      ...(required ? { testPolicy: { suite: "required" } } : {}),
    });
  });
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
const libMissing = (_dir: string, cmd: string) => !cmd.startsWith("lib-");
const changedNotes = (h: DesignHarness) =>
  h.read((db, id) => listEvents(db, id).filter((e) => e.reason === "inputs-changed"));
/** The narrowing notice after `prefix`: its sentence and the list of skipped components. */
const notice = (out: string, prefix: string): string | null =>
  out.match(new RegExp(`^${prefix}(skipping [^\\n]*\\n(?:- [^\\n]*\\n)*)`, "m"))?.[1] ?? null;
/** The reason of the one pending human_resume (the checks pause's, in these runs). */
const checksPauseReason = (h: DesignHarness): string =>
  h.read((db, id) => {
    const pending = listPending(db, id).filter((s) => s.signal_type === "human_resume");
    expect(pending.length).toBe(1);
    return pending[0]?.reason ?? "";
  });
const components = (h: DesignHarness) =>
  h.read((db, id) =>
    (
      JSON.parse(getInput(db, id, "profile.components")?.value_json ?? "[]") as { name: string }[]
    ).map((c) => c.name),
  );

test(
  "a resume missing an optional component's tools narrows it, says so, and reports it for the PR",
  async () => {
    const h = make("worktree", false);
    expect(await h.fresh()).toBe(75);
    expect(components(h)).toEqual(["app", "lib"]);
    expect(checksPauseReason(h)).toContain("; lib: ");
    h.probe = libMissing;
    expect(await h.resume()).toBe(75);
    expect(h.stderr.join("")).toContain(
      "resume: skipping 1 component(s) whose toolchain is absent; the run continues with app.",
    );
    expect(components(h)).toEqual(["app"]);
    const note = changedNotes(h).at(-1);
    expect(JSON.parse(note?.payload_json ?? "{}").names).toEqual([
      "profile.components",
      "run.unusableComponents",
    ]);
    // worktree mode reruns provision (recreated worktree); it now carries the unusable list (ENG-412)
    const toolchain = h.read((db, id) =>
      listSignals(db, id).filter((s) => s.signal_type === "toolchain"),
    );
    expect(JSON.parse(toolchain.at(-1)?.detail_json ?? "{}").components).toEqual(["lib"]);
    // the handlers got the narrowed profile too: checks:dispatch ran again and judged only app
    const reason = checksPauseReason(h);
    expect(reason).toStartWith("checks:dispatch:");
    expect(reason).toContain("app: ");
    expect(reason).not.toContain("lib: ");
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a resume missing a required suite's tools pauses needs_you (75) and drops nothing",
  async () => {
    const h = make("in-place", true);
    expect(await h.fresh()).toBe(75);
    const agentCalls = JSON.stringify(h.calls.counts);
    h.probe = libMissing;
    expect(await h.resume()).toBe(75);
    const out = h.stderr.join("");
    expect(out).toContain("resume: paused:");
    expect(out).toContain("lib-build");
    expect(out).toContain("resume: paused: this host lacks the tools for lib");
    expect(JSON.stringify(h.calls.counts)).toBe(agentCalls); // nothing ran
    expect(components(h)).toEqual(["app", "lib"]);
    expect(changedNotes(h)).toEqual([]);
    h.read((db, id) => {
      const pending = listPending(db, id).filter((s) => s.signal_type === "human_resume");
      // exactly one, written by pauseTicket after the resume transaction consumed the checks
      // pause's signal: only the narrowing placed after that transaction (spec §4.1) leaves this
      expect(pending.length).toBe(1);
      expect(pending[0]?.reason).toStartWith("this host lacks the tools for lib");
    });
    h.probe = () => true; // the operator installs the tools
    expect(await h.resume()).toBe(75); // back to the checks pause, with nothing changed
    expect(changedNotes(h)).toEqual([]);
    // the probe the resume was given decides, not the host's real tools (no `lib-build` here)
    expect(h.stderr.join("")).not.toContain("resume: paused:");
    h.read((db, id) => {
      const pending = listPending(db, id).filter((s) => s.signal_type === "human_resume");
      expect(pending.length).toBe(1);
      expect(pending[0]?.reason).toStartWith("checks:dispatch:");
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

for (const mode of ["in-place", "worktree"] as const) {
  test(
    `${mode}: no false change when a component's toolchain was already missing at the fresh run`,
    async () => {
      const h = make(mode, false);
      h.probe = libMissing;
      expect(await h.fresh()).toBe(75);
      const freshNotice = notice(h.stderr.join(""), "run: ");
      expect(freshNotice).toContain(
        "skipping 1 component(s) whose toolchain is absent; the run continues with app.\n- lib: skipped",
      );
      expect(components(h)).toEqual(["app"]);
      expect(await h.resume()).toBe(75);
      expect(changedNotes(h)).toEqual([]);
      // one decision: the resume narrows the same way and says the same sentence
      expect(notice(h.stderr.join(""), "resume: ")).toBe(freshNotice);
    },
    HARNESS_TEST_TIMEOUT_MS,
  );
}

test(
  "a resume the plan review gate leaves waiting records the missing tools as a note and adds no second pause",
  async () => {
    const h = make("in-place", true);
    // The same required plan finding on every review: the run stops at the plan review gate, and
    // the resume transaction applies that stop again (the plan is unchanged), leaving it waiting.
    const script = {
      planFindings: () => [
        {
          severity: "critical" as const,
          category: "correctness",
          location: null,
          rationale: "the plan misses the point",
          factors: null,
          deferral_candidate: false,
          work_unit_seq: null,
        },
      ],
    };
    expect(await h.fresh({ script })).toBe(75);
    h.probe = libMissing;
    expect(await h.resume({ script })).toBe(75);
    expect(h.stderr.join("")).toContain(
      "resume: paused: the run is already waiting for you, and this host lacks the tools for lib (missing: `lib-build`",
    );
    h.read((db, id) => {
      const pending = listPending(db, id).filter((s) => s.signal_type === "human_resume");
      expect(pending.map((s) => s.reason)).toEqual(["no progress: identical plan-review findings"]);
      const events = listEvents(db, id);
      const notes = events.filter((e) => e.reason === "toolchain-missing");
      expect(notes.length).toBe(1);
      expect(JSON.parse(notes[0]?.payload_json ?? "{}").detail).toStartWith(
        "this host lacks the tools for lib",
      );
      // the gate's escalation, applied again by the resume transaction; none for the tools
      const resumedAt = events.findIndex((e) => e.kind === "resumed");
      expect(resumedAt).toBeGreaterThan(-1);
      expect(
        events
          .slice(resumedAt)
          .filter((e) => e.kind === "escalated")
          .map((e) => e.reason),
      ).toEqual(["no progress: identical plan-review findings"]);
    });
    expect(components(h)).toEqual(["app", "lib"]);
  },
  HARNESS_TEST_TIMEOUT_MS,
);
