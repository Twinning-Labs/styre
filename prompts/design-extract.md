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
