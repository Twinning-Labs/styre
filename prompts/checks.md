You are authoring acceptance checks for ticket {{ident}} ("{{title}}") in project {{slug}}.

For each acceptance criterion below, author ONE **new** test file in this repository's own test
framework whose test(s) **FAIL on the current code** because the criterion is not yet met, and would
pass once it is. You are given the criteria and the project's detected stacks and test commands — you are
NOT given the implementation plan. Read the repository (Read/Grep/Glob) enough to write a *valid,
runnable* failing test; do not guess blindly.

{{checks_feedback}}

Rules — follow them exactly:
- **One new file per criterion.** Create a brand-new test file. Do NOT edit, extend, or add to any
  existing test file — the runner will reject a check whose file is not newly added.
- **Write the file at the canonical path** `<test-root>/styre_checks/{{ident}}_ac<id>_test.<ext>`, where
  `<test-root>` is a directory this component's test command already discovers. The `styre_checks/`
  subdirectory only selects *where under the discovered root* — it does NOT override discovery: if your
  location is not picked up by the test command, the RED-first self-check below will ERROR
  (collection/import) instead of failing on the assertion, which means the placement is wrong — fix it.
  Use the stack-appropriate extension; for Go or Rust give the file its own package/module directory under
  that path.
- **Declare the byte-identical path you wrote.** The `test_file` you report in `checksAuthored` (below)
  MUST be exactly the repo-relative path you created — the same string, character for character, with no
  dropped or added path segment (do not omit `styre_checks/`) and no leading `./`. A declared path that
  differs from the written path is a defect.
- The file must contain **only** this criterion's check(s) — nothing else.
- **Assert the criterion's *observable output*, not just that the surface responded.** Check the
  returned data shape / a persisted value / a produced side-effect — the thing the AC actually
  promises. A status-code-only or existence-only assertion (e.g. `assert resp.status == 201` with no
  check of the body, or `assert hasattr(mod, "fn")`) is too weak: a stub that returns `201 {}` would
  pass it. Make the assertion one a stub cannot satisfy without doing the work.
- **Run each check you write and CONFIRM it FAILS on the current (unfixed) code before you finish.** Use
  the detected test command for the matching stack. A check that PASSES right now is *vacuous* — it is not
  testing the criterion — so if it passes, or fails only for a trivial reason (import/syntax/collection
  error rather than the asserted behavior), fix it until it fails *because the criterion is unmet*. You
  still do NOT report a verdict — the runner re-runs your checks as the source of truth; you run them only
  to prove they are genuinely RED-first.
- **For a numeric, data-shape, or algorithmic criterion, assert the SPECIFIC correct value the fixed code
  must produce** (the one that differs from the current wrong output) — never a property that holds
  regardless of the fix. If you cannot state the exact expected value, read the code/docs until you can.
- **Keep scratch OUT of the work tree.** Do any bug-reproduction, debugging, or throwaway scripting
  outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all. Never write repro/
  debug/scratch files into the work tree "to delete later," and never park them in `new_files`. The
  commit is REJECTED if it contains any NEW file you did not declare — your check files (listed in
  `checksAuthored` via `test_file`) plus any genuine non-test helper (listed in `new_files`, below) — so
  the only correct outcome is: check files declared, real helpers declared, and nothing else added.

## Acceptance criteria (author one check file per `ac_id`)

{{acceptance_criteria}}

## Detected stacks (from `styre setup` — ground truth; use the matching framework + test command)

{{detected_stacks}}

Emit your answer as a single fenced block, exactly:

```styre-sidecar
{
  "checksAuthored": [
    { "ac_id": 7, "test_file": "api/tests/styre_checks/ENG-1_ac7_test.py", "test_name": "test_health_returns_200" }
  ],
  "new_files": []
}
```

Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result. If — and only if — a
check genuinely needs a NEW non-test helper (a fixture / `conftest.py`) — never a reproduction or debug
script — list its repo-relative path in `new_files`; your test files are already declared via `test_file`
and must NOT be repeated there. Otherwise leave `new_files` empty.
