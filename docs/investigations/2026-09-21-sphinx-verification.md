# Sphinx requirement and verification evidence

Investigated the retained 20 September 2026 Sphinx 7590 run at Styre 6414689 and bench cc75f2c. The candidate cost $11.20785435; its held-out evaluation was unresolved with 24 preservation tests passing. No held-out fix/test patches were read during this investigation, and no model or benchmark matrix run was started.

## Observed, not inferred

The original ticket requests C++ user-defined literal support and demonstrates a declaration containing `6.62607015e-34q_J * 1q_s`. Its sole extracted criterion says “The reported bug no longer reproduces.” The plan additionally describes literal identifiers, round trips, numeric/string/character variants and existing-test compatibility.

The retained acceptance check genuinely reproduced the parsing error before implementation and passed afterward. The implementation's added expression tests asserted identifier strings constructed with the same extra terminator as its new `get_id` implementation. A separate offline probe composed the public base repository's existing `ASTOperatorLiteral` and `ASTPostfixCallExpr` methods: for `1q_s`, that composition produces `clli3q_sL1EE`, whereas the candidate returns `clli3q_sEL1EE`. Thus candidate/test agreement missed a public-contract inconsistency. This is an independently reproduced defect, not a claim that we inspected or established the exact held-out failing assertion. The candidate also splits `1foo` into literal `1f` and suffix `oo`, so correct round-trip text alone does not establish semantic parsing.

Replayed the pristine migrated image `swebench/sweb.eval.x86_64.sphinx-doc_1776_sphinx-7590:latest`, image ID `5c86dab7120b83b3bdb4af86743a3910da328029ed92183477fe9865ea76cb2f`, base commit `3f69f85506e8d069fc18ee1f79b0c160321f6440`, offline. Only agent-authored candidate source/tests were applied:

- Public C++ domain tests: base 25 passed; candidate 25 passed.
- Candidate's complete authored acceptance file: 3 passed.
- Broad suites, explicitly stopped after 3 failures: base 71 passed/3 failed; candidate 74 passed/3 failed. Both first fail on `test_extension_in_blacklist`, `test_add_is_parallel_allowed`, and `test_build_all[text]`.

These observations contradict an assumption that the broad nonzero exit necessarily identifies the candidate defect. They do not establish that every suite failure is pre-existing or that every later test passes. Raw replay diagnostics and the reproduction script remain at `/home/rajatgoyal/styre-investigations/sphinx-20260921` on the Linux host.

Checkpoint signals 9/18 retain exit 1 with empty stderr for component tests. Signals 14/21 retain `preexisting:true` for integration with only job exit/timing information; neither baseline output nor baseline revision is retained. The public code maps any nonzero detached-baseline command to that boolean. A separate synthetic git repository reproduced a candidate dependency present while absent in the unprovisioned baseline: exit 127 was previously sufficient to exonerate the candidate.

## General corrections

Original ticket descriptions now reach check authoring, classification and arbitration without exposing the implementation plan. Correct already-green expectations must not be changed just to manufacture RED. Review explicitly checks public contracts and original requirements rather than treating matching candidate/tests as independent correctness evidence. This improves available context; it does not mechanically certify semantic coverage. Deterministic execution-class shortcuts still do not constitute semantic adjudication.

Suite execution now retains versioned, bounded command observations: actual checkout SHA, command/cwd, exit/timeout status, stdout/stderr and truncation. Process capture and descendants are bounded; detached process groups use recovery journaling. Nonzero exit codes are observations, not classifications of assertion/environment failure. Baseline observations include preparation failures and explicitly unqualified comparisons. No legacy boolean or pair of exits authorizes causal wording or an evidence-floor bypass.

Independent review and repair receive neutral diagnostics, including ticket-level integration, aggregate failure reasons, old/current revision provenance, unavailable baseline evidence and jobs not executed. Latest successful observations clear earlier warnings only within the same work-unit/type scope. Suite failures remain advisory pending an independently justified finding under the bounded review/repair workflow.

## Remaining limits and validation boundary

The original run's discarded stdout and baseline evidence cannot be recovered from its checkpoint; offline replays are new observations. Equivalent baseline dependency provisioning/source binding and structured test-identity/phase comparisons across runners remain prerequisites for automatic regression attribution. This change does not introduce a blanket “fix all failed tests” policy, promise oracle resolution, fix Sphinx itself, or address PR delivery. A new paid targeted run requires separate authorization.

Primary references used for independent contract checks: [Itanium C++ ABI](https://itanium-cxx-abi.github.io/cxx-abi/abi.html), [C++ draft user-defined literals](https://www.eel.is/c%2B%2Bdraft/lex.ext), and the public pre-fix Sphinx parser methods. No gold patch supplied the expected identifier.


## Validation and independent review

Independent review reproduced two diagnostic defects during implementation: updating a previously seen scope could hide its newest failure after truncation, and an invalid observation could be mistaken for available evidence. Both now have regression coverage and passed independent re-review. Prompt routing fixtures now identify the classifier by its role prefix instead of matching a word also present in author instructions.

The initial Linux full suite reported 1,952 passed, 9 skipped, no failed assertions, but process exit 65. The preserved main-branch run likewise reported 1,942 passed, 9 skipped, no failed assertions and exit 65. The shared test helpers mutated global `process.exitCode` without restoring it. All four affected helper paths now scope that mutation, return observed CLI outcomes where applicable, and restore the caller's prior status. Regression tests fail on main and pass with the correction; independent testing confirmed that a deliberately failing assertion still exits 1. Bun 1.4.2 ignored restoration to `undefined` in a minimal reproduction, so an unset prior status is restored as 0. See the [process exit-code contract](https://nodejs.org/api/process.html#processexitcode).

The Mac sandbox full suite and unchanged-main control both exhibit the same eight failing test identities (live-parent lock tests and telemetry opt-in tests). Linux validation is the representative full-suite result; Mac failures are retained rather than counted as a clean run. Optional native/environment cases remain explicitly skipped where their fixture dependencies are not configured.
