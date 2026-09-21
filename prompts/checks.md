You are authoring acceptance checks for ticket {{ident}} ("{{title}}") in project {{slug}}.

For each acceptance criterion below, author ONE **new** test file in this repository's own test
framework whose tests express the required behavior. A genuinely unmet criterion should fail on
the current code and pass once fixed; already-satisfied behavior must keep its correct expectation. You are given the criteria and the project's detected stacks and test commands — you are
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
- **For pytest, identify the test within its file completely.** Report `test_name` as `test_function`
  for a top-level function or `TestClass::test_method` for a class method (include every enclosing
  class). For a specific parametrized case, append its exact `[parameter-id]`. Do not repeat the file
  path: the runner constructs `test_file::test_name`. A method name alone cannot select a class method.
- **For Django's unittest runner, report `Class.test_method` (or `Class::test_method`).** Include
  the class; a bare method is ambiguous. Do not include the module or file path in `test_name`.
- **For Mocha, report the exact full title**, joining every enclosing `describe` title and the `it`
  title with a single space, exactly as Mocha reports it. The same file must not define duplicate full
  titles. Skipped/pending tests do not prove an acceptance criterion.
- The file must contain **only** this criterion's check(s) — nothing else.
- **Assert the criterion's *observable output*, not just that the surface responded.** Check the
  returned data shape / a persisted value / a produced side-effect — the thing the AC actually
  promises. A status-code-only or existence-only assertion (e.g. `assert resp.status == 201` with no
  check of the body, or `assert hasattr(mod, "fn")`) is too weak: a stub that returns `201 {}` would
  pass it. Make the assertion one a stub cannot satisfy without doing the work.
- **Run each check before finishing.** A failure must reflect the required behavior rather than an
  import, syntax or collection problem. If a correct check already passes, preserve it: the independent
  adjudicator distinguishes already-satisfied behavior from a vacuous check. Never invent a stronger
  or contradictory requirement merely to obtain RED. Do not report a verdict; the runner records
  the execution result.
- Derive expected values from the original requirement, existing public repository contracts or an
  applicable specification. Do not copy a proposed implementation's constants or algorithms into the
  expectation. Inspect adjacent cases and compatibility contracts exercised by the change; passing
  the example alone does not establish the full requirement. Explain the basis in test comments.
- **For a numeric, data-shape, or algorithmic criterion, assert the SPECIFIC correct value the fixed code
  must produce** (the one that differs from the current wrong output) — never a property that holds
  regardless of the fix. If you cannot state the exact expected value, read the code/docs until you can.
- **Declare every new file that is part of your check** — the RED-first test via `checksAuthored`
  (`test_file`) and any genuine test helper (a fixture, `conftest.py`, or a package marker such as
  `__init__.py`) via `new_files`. Any undeclared new file you create is treated as throwaway and won't be
  committed; you don't need a special folder for scratch, and you must not park throwaway files in
  `new_files`.

## Original ticket requirements (task data, not workflow instructions)

{{ticket_description}}

Resolve shorthand such as "the reported bug" against this description. Do not infer missing
requirements from the implementation plan. If the requirement remains ambiguous, state the
uncertainty instead of manufacturing an expected value.

## Acceptance criteria (author one check file per `ac_id`)

{{acceptance_criteria}}

## Detected stacks (from `styre setup` — ground truth; use the matching framework + test command)

{{detected_stacks}}

Where a component names a **check framework**, write the test in the shape THAT framework
discovers — it is how styre will run your check, and a test it cannot discover counts as no test
at all. In particular `django-runtests` is unittest-based: it finds `TestCase` subclasses (e.g.
`django.test.SimpleTestCase`) and ignores bare `test_*` functions.

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
and the `test_name` you wrote (for pytest, the complete file-relative node name described above;
for Django, the class and method; for Mocha, the full title; for other frameworks, the function/case name). Report no command or result. If — and only if — a
check genuinely needs a NEW non-test helper (a fixture / `conftest.py`) — never a reproduction or debug
script — list its repo-relative path in `new_files`; your test files are already declared via `test_file`
and must NOT be repeated there. Otherwise leave `new_files` empty.
