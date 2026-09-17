# Authored test execution and identity

A test name is a framework identifier, not necessarily a literal string in source. Matrix 5
exposed this in Mocha (`describe` + `it` titles) and Django (`Class::method`). It also exposed a
separate launcher problem: a package's `npm run test` can change directory before invoking Mocha.
Repository-relative paths, launcher cwd, and selector cwd are distinct facts.

`src/dispatch/check-execution.ts` resolves a version-1 execution plan from the qualified component
and authored file/name. It records the framework, component, repository-relative test path,
logical name, launcher, launcher cwd, selector cwd, and selection arguments. Resolution rejects
unsafe paths, an unresolved framework, and ambiguous component ownership. The deepest containing
component directory wins; equally specific owners require correction rather than array-order choice.
Arguments containing shell metacharacters are quoted.

The RED-first signal stores this plan alongside command, output, and exit status. Post-implement
verification consumes that plan rather than rediscovering the launcher from a changed profile.
Re-authoring uses the same resolver and executor in the baseline worktree and preserves its actual
trace and plan when installing a replacement. Delivered test binding uses a file-scoped plan and
records the execution evidence, including an unknown result.

## Identity and result contracts

- **Mocha:** `test_name` is the exact `fullTitle`. Selection uses an escaped, anchored `--grep`.
  The runner forces JSON reporting, disables dry-run, parallel, bail, and inverted matching, and
  reads a fresh temporary reporter file. Package-manager banners/footers cannot become verdicts.
  The report must be complete, counts must agree, and named AC checks must report only the requested file/name. File-scoped binding evaluates
  only the requested file's rows, even when wrapper globs run other tests. Failure events may
  repeat for one test (observed in MUI 39353); distinct completed-test identities must be unique. Zero tests or all-pending tests
  are `selected-none`; hook failures, incomplete reports, unexpected identities, launch failures,
  and timeout are errors. A delivered regression test binds only when the failed target tests
  carry assertion evidence; a runtime exception or Mocha timeout is not sufficient.
- **Django's runtests:** `test_name` is `Class.method` or `Class::method`, normalized to the exact
  `module.Class.method` label. Bare method names are rejected. Verbosity-2 unittest output must
  identify the expected tests and agree with the reported run count. Skips do not count as passes;
  `ERROR` is not an assertion failure. Delivered binding also requires each failed test's final
  traceback to include its named body in the requested source file; fixture assertions remain
  unproven. Hyphenated authored module names are preserved.
- **pytest:** file-relative node suffixes preserve enclosing classes and parameter IDs. A new
  execution plan requires a positive passing-test count for GREEN; a successful collection-only
  or all-skipped invocation is not GREEN. Existing RED/absence classification remains in place.
  Delivered binding additionally requires a failed-test count with corresponding assertion
  diagnostics and no collection-error count.
- **Other existing adapters:** selection uses the same directory/launcher plan, with their existing
  result readers. Delivered behavioral binding remains **unknown** until an adapter can establish
  an assertion failure; no generic nonzero-exit fallback is allowed. These adapters do not gain
  Mocha's structured per-test identity guarantees merely by using a plan.

A behavioral failure proves execution of an assertion, not that the assertion adequately captures
the ticket. The existing adjudicator, acceptance gate, and independent code review retain that job.

## Qualified wrappers and early failure

Setup recognizes Mocha directly or through one package-manager script, using a closed grammar:
optional `cd <relative-path> &&`, optional `env`/`cross-env` and assignments, then `mocha` with
literal arguments. It preserves the wrapper, configuration and environment, and records the
wrapper's selector directory. Shell substitutions, pipelines, script chains, watch/help modes,
and ambiguous commands are not guessed. An explicit `testAction` remains available for a
repository whose launcher cannot be inferred. `selectorDir` is relative to the component's launch
cwd and must resolve inside the repository.

Preserving a wrapper also preserves its default file globs: other files can be **loaded** even
though an exact name filter restricts AC test execution. File-scoped delivered binding may execute
other suite tests, but their results never count as proof about the target file. Unexpected executed
identities in named AC runs fail closed.
Configuration conflicts (for example an incompatible `fgrep`) are errors, not successful checks.
A version/help probe proves the launcher can start; identity is established by the subsequent test
execution, not by the probe.

Before authoring, capability probes are recorded. If a required owner of planned behavioral work
cannot run checks, or no component can run a check, the step throws a journaled
`StepPrerequisiteError`. Failure policy pauses immediately with the diagnosis; repairing the
runner/profile and resuming retries that prerequisite. Nonbehavioral work can retain an explicit
capability advisory without dispatching an author. A separate runnable component cannot hide a
known required owner's failure.

## Existing checkpoints

The optional plan lives in the existing RED-first signal JSON; no database migration is required.
Malformed/unknown plan versions fail closed. Legacy root checks for existing adapters keep their
historical invocation. Legacy nested checks and Django module-only checks lack enough information
to recover an exact execution identity, so they fail with a re-authoring diagnosis. A fresh run
writes plans for every new check. Changing configuration does not silently reinterpret a persisted
plan; re-authoring creates a new generation.

## Validation and references

Unit/workflow tests cover path ownership, checkpoint reuse, malformed plans, capability failure,
re-authoring, and baseline binding. `test/dispatch/check-execution.test.ts` also has native
compatibility tests, run by the `native-test-contracts` CI job. To run them locally, set `STYRE_TEST_NATIVE_ROOT` to a directory containing `node_modules/mocha`
and `venv/bin/python` with Django/pytest. Validated versions are Mocha 10.2.0 on Node 20.19.5,
Django 4.2.23, and pytest 8.3.5. Native tests exercise real failures and passes, composed titles,
configuration overrides, skipped tests, duplicate identities, hook errors, and nested paths.

The framework contracts are grounded in [Mocha's JSON reporter](https://mochajs.org/reporters/json/),
[configuration merging](https://mochajs.org/running/configuring/), the
[10.2.0 CLI option definitions](https://github.com/mochajs/mocha/blob/v10.2.0/lib/cli/run-option-metadata.js),
[unittest's dotted-name loader and result protocol](https://docs.python.org/3/library/unittest.html),
and [Django's test-selection documentation](https://docs.djangoproject.com/en/3.0/internals/contributing/writing-code/unit-tests/).
