You are extracting the work breakdown for ticket {{ident}} ("{{title}}") in project {{slug}}.

A design plan has already been written and committed under `docs/plans/`. Read it (and any
files it references) and decompose it into an ordered list of work units the build system will
implement and verify one at a time. Do NOT write or edit any files — your only output is the
sidecar block described below.

## Detected stacks (from `styre setup` — ground truth)

{{detected_stacks}}

When a work unit is specific to one of these stacks, use that stack's **kind** as the unit `kind`
(e.g. `go`, `sveltekit`) rather than a generic label. Cross-cutting kinds (`docs`, `config`,
`migration`) remain valid. If a unit must change files in **more than one** of these stacks, say so
explicitly in the plan — it is a cross-stack change the build system will need to verify carefully.

For each work unit decide:
- **seq**: 1-based position. Number units 1..N with no gaps. A unit may only depend on
  strictly-earlier seqs (`depends_on`).
- **kind**: the work type — **prefer one of the project's detected stacks above** when the unit is stack-specific (e.g. `go`, `sveltekit`); otherwise a role like `docs`, `config`, `migration`.
- **title** / **description**: a short title and a one-paragraph description.
- **behavioral**: `true` if the unit changes observable program behavior and therefore must be
  covered by a test; `false` for docs-only, config-only, or pure-scaffolding units that cannot
  carry a behavioral test. Be deliberate: a unit marked behavioral MUST have a `test_plan` and
  MUST include `"test"` in its `verify_check_types`.
- **test_plan**: how the unit is tested (required when behavioral; use `null` otherwise).
- **files_to_touch**: declare **every file this unit's implement step will create or change** — production code, docs, **and its tests, including a test that also happens to cover an acceptance criterion**. The rule is *authorship*, not purpose: if implement writes the file, list it here. **Never list a file `checks:dispatch` authors** — the per-acceptance-criterion RED-first checks it writes at the canonical path `<test-root>/styre_checks/{ident}_ac<id>_test.<ext>`; you signal the need for those via `verify_check_types: ["test"]`, not as a file here, and they are gated separately (RED-first + `verify:checks-gate`). A product test that overlaps an acceptance criterion is ordinary engineering, not duplication — it is implement's to write, so declare it; the frozen `styre_checks/` check decides the AC regardless. When an artifact's exact filename is not knowable at design time (e.g. a changelog fragment named by the not-yet-existing PR number), declare it with an angle-bracket placeholder for the unknown segment — e.g. `docs/changes/modeling/<id>.bugfix.rst` — the build system matches the placeholder against the file actually produced.
- **verify_check_types**: the ground-truth checks that gate this unit, e.g. `["test"]`,
  `["lint"]`, `["build"]`. Behavioral units must include `"test"`.
- **depends_on**: seqs of earlier units that must be verified before this one.

## Runtime context (from the project profile — treat as ground truth)

- Topology: {{runtime_topology}} — {{runtime_topology_detail}}
- Data/persistence: {{runtime_data_presence}} — {{runtime_data_detail}} (migration tool: {{runtime_data_migration_tool}})
- Caching: {{runtime_caching_presence}} — {{runtime_caching_detail}}
- Observability: {{runtime_observability_presence}} — {{runtime_observability_detail}}
- Config/secrets: {{runtime_config_secrets_presence}} — {{runtime_config_secrets_detail}}
- Documentation: {{runtime_documentation_presence}} — {{runtime_documentation_detail}}

For every section flagged `present` or `unknown`, you MUST fill the matching `cdotImpact` entry
with a non-empty `analysis` (state "N/A — <reason>" if it genuinely does not apply). If your plan
changes the database schema, set `cdotImpact.data.schemaChange: true` AND include a dedicated
migration work unit (kind `migration` or `data`) ordered before the units that use the new schema.
Add a telemetry step to behavioral units and map each external boundary's failure mode to a test.

Documentation is soft-gated: even when it is flagged `absent`, still consider whether a
significant change warrants a doc note (README/changelog), and if so set
`cdotImpact.documentation.applies: true` with a short `analysis`. This is a nudge, not a
requirement — a trivial change legitimately leaves it `false`.

When you add a changelog/doc-fragment work unit whose filename encodes a value you cannot know yet (a PR or issue number), put an angle-bracket placeholder in its `files_to_touch` path (e.g. `docs/changes/<area>/<id>.bugfix.rst`) rather than guessing a literal number.

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
  ],
  "cdotImpact": {
    "data": { "applies": false, "analysis": "", "schemaChange": false },
    "caching": { "applies": false, "analysis": "" },
    "observability": { "applies": false, "analysis": "" },
    "configSecrets": { "applies": false, "analysis": "" },
    "documentation": { "applies": false, "analysis": "" }
  }
}
```
