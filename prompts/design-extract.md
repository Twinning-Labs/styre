You are extracting the work breakdown for ticket {{ident}} ("{{title}}") in project {{slug}}.

A design plan has already been written and committed under `docs/plans/`. Read it (and any
files it references) and decompose it into an ordered list of work units the build system will
implement and verify one at a time. Do NOT write or edit any files — your only output is the
sidecar block described below.

For each work unit decide:
- **seq**: 1-based position. Number units 1..N with no gaps. A unit may only depend on
  strictly-earlier seqs (`depends_on`).
- **kind**: the work type, e.g. `backend`, `frontend`, `data`, `docs`, `config`.
- **title** / **description**: a short title and a one-paragraph description.
- **behavioral**: `true` if the unit changes observable program behavior and therefore must be
  covered by a test; `false` for docs-only, config-only, or pure-scaffolding units that cannot
  carry a behavioral test. Be deliberate: a unit marked behavioral MUST have a `test_plan` and
  MUST include `"test"` in its `verify_check_types`.
- **test_plan**: how the unit is tested (required when behavioral; use `null` otherwise).
- **files_to_touch**: the files this unit is expected to change.
- **verify_check_types**: the ground-truth checks that gate this unit, e.g. `["test"]`,
  `["lint"]`, `["build"]`. Behavioral units must include `"test"`.
- **depends_on**: seqs of earlier units that must be verified before this one.

Emit your answer as a single fenced block, exactly:

```styre-sidecar
{
  "units": [
    {
      "seq": 1,
      "kind": "backend",
      "title": "…",
      "description": "…",
      "behavioral": true,
      "test_plan": "…",
      "files_to_touch": ["src/…"],
      "verify_check_types": ["test"],
      "depends_on": []
    }
  ]
}
```
