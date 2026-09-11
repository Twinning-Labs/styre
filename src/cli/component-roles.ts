import { type ComponentRole, isPrimary } from "../dispatch/profile.ts";
import type { Component, Profile } from "../dispatch/profile.ts";
import { noPrimaryComponentError } from "./errors.ts";

/** One component this run will not touch, and what it was classified as. */
export interface NonPrimaryComponent {
  component: string;
  role: ComponentRole;
  /** The discovery agent's own description — the sentence that explains the classification to a
   *  human reading the PR. Absent when the agent wrote none. */
  label?: string;
}

/** What the run decided about component roles: what it will use, and what it will not. */
export interface RoleGate {
  /** `profile`, narrowed to the components that take part in the run. */
  profile: Profile;
  /** Components dropped from that profile, with the role that dropped them. */
  nonPrimary: NonPrimaryComponent[];
}

/**
 * Exclude non-primary components from the run (ENG-425).
 *
 * WHY THIS EXISTS. `mergeComponents` lets the deterministic scan anchor which components exist,
 * and the discovery agent may refine but never invent one. That rule is right and it had no
 * inverse: the scan creates a component for every nested `setup.py`, including the ones under
 * `extra/`, `testing/` and `examples/`. On pytest-dev__pytest-5631 it produced a component for
 * `extra/setup-py.test` — a name-reservation stub — with `prepare: pip install -e .`. The agent
 * recognised it exactly, writing "legacy stub package (py.test name reservation, sdist-only, no
 * real tests)" into `label`, and had no field in which to act on that. The install exited 1 and
 * the run escalated at tick 1 having done no work, for $0.25.
 *
 * `role` gives the agent somewhere to put a judgment it was already making. This applies it.
 *
 * NEVER SILENT. `nonPrimary` is returned so the caller can say what it is skipping, on stderr
 * and in the PR — the same contract ENG-412 established for a missing toolchain. A narrowing
 * that only ever reaches stderr is a silent one by the time anybody reviews the diff.
 *
 * Narrowing is returned as a NEW profile and never written back to disk. Unlike the toolchain
 * gate — where what is missing is a property of the host — `role` IS a property of the repo and
 * belongs in the profile; but which components a given RUN used is a property of the run.
 *
 * Pure — no side effects.
 */
export function partitionByRole(profile: Profile): {
  primary: Component[];
  nonPrimary: NonPrimaryComponent[];
} {
  const primary: Component[] = [];
  const nonPrimary: NonPrimaryComponent[] = [];
  for (const c of profile.components) {
    if (isPrimary(c)) {
      primary.push(c);
      continue;
    }
    nonPrimary.push({
      component: c.name,
      // `isPrimary` already established this is not primary, so the coalesce is unreachable —
      // it exists only so this never widens `role` back to `undefined` for the report.
      role: c.role ?? "primary",
      ...(c.label ? { label: c.label } : {}),
    });
  }
  return { primary, nonPrimary };
}

/**
 * The run-start role decision, extracted so it is testable without driving a whole run.
 *
 * Throws `noPrimaryComponentError` (exit 69 — its own headline, because nothing is missing
 * from the machine) iff EVERY component was classified non-primary. That is not
 * a run worth starting — it would provision nothing, verify nothing and reach `pr-ready` having
 * measured nothing, which is exactly the shape ENG-424's evidence floor exists to refuse. Better
 * to refuse at the door, where the operator can see the classification that caused it, than to
 * spend a run discovering it. It also fails closed on the realistic mistake: a discovery agent
 * that misreads a repo and demotes everything cannot quietly produce an empty run.
 */
export function applyRoleGate(profile: Profile): RoleGate {
  const { primary, nonPrimary } = partitionByRole(profile);
  if (nonPrimary.length === 0) return { profile, nonPrimary: [] };
  if (primary.length === 0) {
    throw noPrimaryComponentError(formatNonPrimaryComponents(nonPrimary));
  }
  return { profile: { ...profile, components: primary }, nonPrimary };
}

/** The stderr/PR sentence for a skipped component: what was skipped, and why. */
export function formatNonPrimaryComponents(nonPrimary: NonPrimaryComponent[]): string {
  return nonPrimary
    .map(
      (n) =>
        `- ${n.component}: skipped — classified \`${n.role}\`${n.label ? ` (${n.label})` : ""}`,
    )
    .join("\n");
}
