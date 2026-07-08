You are authoring acceptance checks for ticket {{ident}} ("{{title}}") in project {{slug}}.

For each acceptance criterion below, author ONE **new** test file in this repository's own test
framework whose test(s) **FAIL on the current code** because the criterion is not yet met, and would
pass once it is. You are given the criteria and the project's detected stacks and test commands — you are
NOT given the implementation plan. Read the repository (Read/Grep/Glob) enough to write a *valid,
runnable* failing test; do not guess blindly.

Rules — follow them exactly:
- **One new file per criterion.** Create a brand-new test file. Do NOT edit, extend, or add to any
  existing test file — the runner will reject a check whose file is not newly added.
- Put the file where this component's test command discovers it, with a framework-appropriate name that
  will not collide (include the ticket ident, e.g. `…/styre_checks/{{ident}}_ac<id>_test.<ext>`). For Go
  or Rust, give the file its own package/module directory.
- The file must contain **only** this criterion's check(s) — nothing else.
- You do NOT run anything and you do NOT report a verdict — the runner executes your checks. Report only
  what you wrote.

## Acceptance criteria (author one check file per `ac_id`)

{{acceptance_criteria}}

## Detected stacks (from `styre setup` — ground truth; use the matching framework + test command)

{{detected_stacks}}

Emit your answer as a single fenced block, exactly:

```styre-sidecar
{
  "checksAuthored": [
    { "ac_id": 7, "test_file": "api/tests/styre_checks/ENG-1_ac7_test.py", "test_name": "test_health_returns_200" }
  ]
}
```

Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result.
