import type { Database } from "bun:sqlite";
import { isGatingCheck, listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import {
  type RanJob,
  acEvidenceSha,
  executedJobs,
  isExecutedPass,
  listByTicket as listSignals,
  postImplementAtSha,
  reauthorProvenance,
} from "../db/repos/ground-truth-signal.ts";

export type FloorVerdict = { holds: true } | { holds: false; reason: string };

/**
 * THE EVIDENCE FLOOR (ENG-424, relocated by ENG-439).
 *
 * It used to live in `verify:checks-gate`'s `onSucceed`. `resolver.ts` only SCHEDULES that step
 * when the ticket has active `ac_check` rows — so the two routes that author no checks at all
 * (ENG-426's "nothing here can execute a check" early return, which leaves real acceptance
 * criteria with no checks at all; and a ticket whose description is EMPTY, which yields no
 * criteria either) skipped the gate, skipped the floor, and advanced to `review` having measured
 * nothing. The floor was unreachable on precisely the case it was written for.
 *
 * NOT "a ticket with no parseable AC checklist". The ENG-439 ticket says that and an earlier draft
 * of this file repeated it; it is false. `ac-checklist.ts` falls back to a single
 * `whole-description` criterion for ANY non-empty description, so such a ticket gets a criterion
 * and a check like any other. Only an empty or whitespace-only description reaches the
 * no-criteria branch.
 *
 * So it is no longer a step's verdict. It is a precondition of the stage transition that makes the
 * claim: every path to a pull request crosses `implement → review`, `advance.ts` is the only
 * forward writer of `ticket.stage`, and that transition is computed here from durable state on
 * every tick. There is no version of "the step didn't run" any more.
 *
 * It is evaluated AFTER `verify:integration` and BEFORE `merge:push` / `merge:pr-ensure`, which is
 * the only window where all the evidence exists and nothing has been pushed yet. (The ticket
 * proposed `run-ticket.ts`'s pr-ready return instead; by that line the branch is pushed and the PR
 * is open, so a guard there would only label a claim that had already escaped.)
 */

/**
 * Did this run EXECUTE a test command, at the commit it is about to ship, and did it come back
 * green?
 *
 * Two channels, both keyed to `headSha`, with exactly one exception: the single hop a docs-only
 * carry names (`carriedFrom`, at the bottom of this function). Otherwise never an older commit — a
 * pass recorded against an earlier commit is a fact about that commit: on a multi-unit ticket the
 * first unit's suite ran at its own head and the second unit has changed the code since, so
 * counting it would certify HEAD on the strength of a run against code that no longer exists.
 *
 *  - `integration` — the ticket-level sweep, always run, always at the ticket head. This is the
 *    channel that covers a multi-unit ticket, because it is the only one that re-runs after the
 *    last unit's commit. A job counts when its producer tagged it `test` OR `repo`: `repoCommands`
 *    is where a suite that spans components lives (the setup prompt's own example is
 *    `{"integration": ...}`), so excluding it would make the floor unsatisfiable for every repo
 *    whose end-to-end suite sits there. A `build` job alone is still not evidence — compiling is
 *    not exercising — but say that precisely: it is a COMPONENT `build` command that is excluded.
 *    A repo-wide `{"build": "make"}` is tagged `repo` by origin and IS accepted, because the
 *    producer knows where a command came from and not what it does. So a repo whose only repo-wide
 *    command is a linter satisfies the floor on a linter. The alternative is worse in the one
 *    population that matters — a repo with no component `test` command AND no authored checks has
 *    no other channel at all — but it is a real weakness, not a rounding error. ENG-456 owns the
 *    proper fix: a kind declared per repoCommand by `styre setup`.
 *  - a work unit's `test` sweep at that same head — the narrower, component-scoped evidence
 *    (verify:check runs only the stacks the unit's diff actually touched).
 *
 * WHAT THIS DOES NOT ESTABLISH, stated so nobody reads it as more:
 *  - a unit's `test` pass covers the stacks THAT UNIT's diff touched, not the whole ticket. On a
 *    multi-unit ticket the last unit's sweep is the one that lands at the shipping sha, and it
 *    vouches only for what it ran; `integration` is the channel that covers the rest. Either
 *    satisfies the floor, so a multi-unit ticket whose integration failed can pass on the last
 *    unit's evidence alone. That is the pre-existing behaviour, narrowed — not widened — here.
 *  - "a command exited 0" is not "a test asserted something". `npm test` with no matching tests,
 *    `jest --passWithNoTests` and a no-op test script all exit 0. Vacuous execution is a real and
 *    separate hole; `ac-check-red-first` and `delivered-test-binding` are the mechanisms aimed at
 *    it, not this one.
 *
 * A FAILING integration does NOT count, not even when `detail.preexisting === true`. An earlier
 * version of this accepted that flag — "the suite ran and its failure predates the change" — and a
 * review round showed the flag cannot carry that weight. `runAtBaseline` (`baseline-rerun.ts`)
 * adds a DETACHED worktree under `tmpdir()` and runs the raw profile command in it. Nothing
 * provisions that tree: `node_modules` and `.venv` are untracked, so they are simply absent, and
 * `npm test` there exits 127. `preexistingFrom` maps every non-zero exit to `true`. So a suite
 * this run genuinely broke is stamped pre-existing for any repo whose tests need an install —
 * which is most of them. Its own docstring says "reporting a failure as pre-existing when that was
 * never shown would excuse a real regression, which is the more dangerous of the two errors"; the
 * implementation does exactly that, and this floor is not the place to discover it.
 *
 * Suite observations now retain bounded process diagnostics and baseline comparisons are explicitly
 * unqualified. They still cannot establish passing behavioral evidence or authorize a waiver here.
 * Source/environment qualification and test-identity comparison remain separate prerequisites.

 */
/** Does this job record the execution of something that can exercise behaviour? */
function exercisesBehaviour(j: RanJob): boolean {
  if (j.exitCode === undefined) return false; // not a record of a run at all
  if (j.kind !== undefined) return j.kind === "test" || j.kind === "repo";
  // LEGACY LEDGER. `kind` was added by this change, so every signal written before it carries a
  // label and nothing else — and `styre run --resume` against a pre-upgrade checkpoint is a
  // supported route (`park.ts` migrates the schema, which cannot backfill a JSON column). Without
  // this the integration channel goes silently dead on those ledgers and the operator is told the
  // suite never ran while the record plainly shows it did. Reading the label HERE is not the
  // inference this design rejects: for a row with no `kind` there is nothing else to read.
  return j.label !== undefined && (j.label.endsWith(":test") || j.label.startsWith("repo:"));
}

/** True when the run's own record shows this repo has no channel that could ever satisfy the
 *  floor: the integration sweep PASSED — so every declared job ran — and not one of them was a
 *  test or a repo-wide command. Used only to make the escalation say something actionable
 *  ("declare a test command") instead of "fix what stopped the suite from running". */
function noSuiteDeclaredAt(db: Database, ticketId: number, headSha: string | null): boolean {
  if (headSha === null) return false;
  const integration = listSignals(db, ticketId)
    .filter(
      (s) =>
        s.branch_head_sha === headSha && s.signal_type === "integration" && s.work_unit_id === null,
    )
    .at(-1);
  if (!integration || !isExecutedPass(integration)) return false;
  return !executedJobs(integration).some(exercisesBehaviour);
}

function executedTestEvidenceAt(db: Database, ticketId: number, headSha: string | null): boolean {
  // The resolver returns `verify:integration` whenever the branch head is null, so the floor is
  // never reached with one today. Guarded anyway: this must be total.
  if (headSha === null) return false;
  const atHead = listSignals(db, ticketId).filter((s) => s.branch_head_sha === headSha);

  const integration = atHead
    .filter((s) => s.signal_type === "integration" && s.work_unit_id === null)
    .at(-1);
  if (integration && isExecutedPass(integration)) {
    // `isExecutedPass` already requires every recorded job to have exited 0, so the presence of a
    // behaviour-exercising job among them is enough. `detail.preexisting` is deliberately NOT
    // consulted — see the docblock above.
    if (executedJobs(integration).some(exercisesBehaviour)) return true;
  }

  if (newestUnitSweepPassed(atHead)) return true;

  // A committing `docs:revise` moves the head AFTER the units were swept, and
  // `carryVerifiedVerdictForward` replicates the integration signal to the new head but not the
  // per-unit ones. Pinning the unit channel to the head alone therefore DESTROYED it on exactly
  // the tickets carry-forward exists to rescue — a ticket whose integration was non-green but
  // whose unit sweep was green advanced before the docs commit and escalated after it. The carried
  // signal names the head it was carried FROM, so the unit channel follows it there and the two
  // channels relax together or not at all.
  const carriedFrom = integration
    ? ((JSON.parse(integration.detail_json ?? "{}") as { carriedFrom?: unknown } | null)
        ?.carriedFrom ?? null)
    : null;
  if (typeof carriedFrom !== "string") return false;
  return newestUnitSweepPassed(
    listSignals(db, ticketId).filter((s) => s.branch_head_sha === carriedFrom),
  );
}

/** Did the NEWEST `test` sweep of some work unit, among these signals, pass having executed?
 *
 *  Newest per unit, not "any": at a frozen head — a re-implement that commits nothing, which the
 *  resolver already models as its stuck-HEAD state — an earlier pass and a later fail sit at the
 *  same sha, and `.some()` would let the superseded pass win. The integration channel above takes
 *  `.at(-1)` for the same reason. */
function newestUnitSweepPassed(signals: ReturnType<typeof listSignals>): boolean {
  const newestPerUnit = new Map<number | null, (typeof signals)[number]>();
  for (const s of signals) {
    if (s.signal_type !== "test") continue;
    newestPerUnit.set(s.work_unit_id, s);
  }
  return [...newestPerUnit.values()].some(isExecutedPass);
}

/**
 * Can this run claim to have verified the work it is about to ship?
 *
 * Executed test evidence at the shipping commit satisfies it outright. Failing that, EVERY
 * acceptance criterion must have been proven individually — which is the per-AC requirement
 * ENG-439 is about: the old floor asked `provenAcIds.length === 0`, so one green criterion out of
 * N satisfied it for all N.
 *
 * Note what this deliberately does NOT do. A still-red `environmental` check never escalates a
 * criterion that also has a green gating check. `environmental` is an advisory class by design
 * (`post-implement-rerun.ts`): the check could not execute, the PR body says so, and promoting it
 * to a hard block would repeal that policy for every run in one line and on an LLM adjudicator's
 * label. What DOES escalate is a criterion with no gating check at all — which is exactly
 * django__django-12325 (one criterion, one check, classified environmental, no runnable suite, a
 * pull request behind nothing).
 */
export function evidenceFloor(db: Database, ticketId: number): FloorVerdict {
  const headSha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
  if (executedTestEvidenceAt(db, ticketId, headSha)) return { holds: true };

  const where = headSha ?? "an unknown HEAD";
  const noSuite = noSuiteDeclaredAt(db, ticketId, headSha)
    ? " The integration sweep passed here having run no test and no repo-wide command at all, so this repo currently offers the floor nothing it can read: no component has a runnable `test` command (declared, unavailable, or absent) and `repoCommands` is empty. Give it one, or accept that styre cannot verify a change here."
    : " Resuming cannot change that; fix what stopped the checks or the suite from running, then re-run with --fresh.";
  const acs = listAcs(db, ticketId);
  if (acs.length === 0) {
    return {
      holds: false,
      reason: [
        `evidence floor: nothing executed a test at ${where} and came back clean, and this ticket has no`,
        `acceptance criteria to prove instead — this run verified nothing.${noSuite}`,
      ].join(" "),
    };
  }

  // Share the report's current-head / explicit docs-carry provenance rule.
  const sha = acEvidenceSha(db, ticketId);
  const proven = sha === null ? new Map() : postImplementAtSha(db, ticketId, sha);
  const checks = listAcChecks(db, ticketId);
  // A check whose re-author was REJECTED stays active with its frozen `red_class` — by design
  // (`checks:reauthor`). If a later implement round turns it green, the shared gating set alone
  // would call the criterion proven while `buildVerifyReport` labels it `check-unreplaced`,
  // "a wrong-shape check left active; never verified", and drops `allClean`. That divergence is
  // reachable end to end: the floor holding is exactly what lets the run reach the PR body that
  // contradicts it. Mirroring the report's precedence here is what makes the shared predicate a
  // shared VERDICT rather than a shared filter.
  const rejected = new Set(
    reauthorProvenance(db, ticketId)
      .filter((p) => p.disposition === "rejected")
      .map((p) => p.acCheckId),
  );
  const unproven: string[] = [];

  for (const ac of acs) {
    const mine = checks.filter((c) => c.ac_id === ac.id);
    if (mine.length === 0) {
      unproven.push(`AC${ac.seq} (no check was authored for it)`);
      continue;
    }
    // THE GATING SET, and exactly the one `buildVerifyReport` judges on (`verify-report.ts`:
    // `red_class` `assertion` or `absence`). Sharing the definition is the point — the floor and
    // the PR body must not be able to reach different verdicts about the same criterion, and they
    // did twice: first on a `disposition`ed sibling, then on an `environmental` one. Both are
    // excluded here for the same reason. A dispositioned check is adjudicated as having nothing to
    // run (`rerunAcChecks` skips it before emitting a signal); an environmental one could not
    // execute and is advisory by design. Neither is evidence, and neither is counter-evidence.
    if (mine.some((c) => rejected.has(c.id))) {
      unproven.push(`AC${ac.seq} (a rejected re-author left a wrong-shape check active)`);
      continue;
    }
    const gating = mine.filter(isGatingCheck);
    if (gating.length === 0) {
      // Nothing that could have executed for this criterion did. django__django-12325's exact
      // shape: one criterion, one check, classified `environmental` and permanently advisory.
      unproven.push(
        `AC${ac.seq} (no check that could gate it — ${mine
          .map((c) => c.disposition ?? c.red_class ?? "unclassified")
          .join("/")})`,
      );
      continue;
    }
    // ALL of them must be green: "any" would let a trivially-green check vouch for a criterion its
    // sibling check failed.
    for (const c of gating) {
      const d = proven.get(c.id);
      // `coarse`, NOT `outcome`: a check whose environment RECOVERED is recorded with
      // `outcome: "advisory-red"` and `coarse: "green"`. Reading the field whose name fits the
      // question inverts the answer on exactly that case.
      if (!d || d.coarse !== "green") {
        unproven.push(
          `AC${ac.seq} (check ${c.id} did not come back green at ${sha ?? "any head"})`,
        );
        break;
      }
    }
  }

  if (unproven.length > 0) {
    return {
      holds: false,
      reason: [
        `evidence floor: nothing executed a test at ${where} and came back clean, and these acceptance`,
        `criteria were not proven either: ${unproven.join("; ")}. This run verified nothing it`,
        `can ship.${noSuite}`,
      ].join(" "),
    };
  }
  return { holds: true };
}
