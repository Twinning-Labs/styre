You are designing ticket {{ident}} ("{{title}}") in the project {{slug}}.

Ticket description / acceptance criteria:
{{description}}

{{review_feedback}}

Before planning, read the files, tests, config, and docs this ticket will touch. Do not guess
file paths, APIs, command names, or test strategy the repo can answer — ground the plan in what
you actually find.

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
with `linear: {{ident}}` frontmatter. For each work unit, give a short labelled list so the
extract step can read it cleanly — keep the surrounding reasoning as prose:
- **kind** — the work type (prefer a detected stack below when the unit is stack-specific)
- **files** — the files it will touch
- **behavioral** — yes/no; if yes, how it is tested
- **verify** — the ground-truth check-types that gate it
- **depends on** — earlier work units it needs

## Requirements traceability (include this in the plan)

List each acceptance criterion / explicit requirement from the ticket, and name the work unit(s)
that satisfy it. If a requirement is intentionally out of scope, say so and why. An unmapped
requirement is a completeness gap the reviewer will catch.

Project stack notes: {{stack}}

## Detected stacks (from `styre setup` — ground truth)

{{detected_stacks}}

When a work unit is specific to one of these stacks, use that stack's **kind** as the unit `kind`
(e.g. `go`, `sveltekit`) rather than a generic label. Cross-cutting kinds (`docs`, `config`,
`migration`) remain valid. If a unit must change files in **more than one** of these stacks, say so
explicitly in the plan — it is a cross-stack change the build system will need to verify carefully.

## Runtime context (from the project profile — treat as ground truth)

- Topology: {{runtime_topology}} — {{runtime_topology_detail}}
- Data/persistence: {{runtime_data_presence}} — {{runtime_data_detail}} (migration tool: {{runtime_data_migration_tool}})
- Caching: {{runtime_caching_presence}} — {{runtime_caching_detail}}
- Observability: {{runtime_observability_presence}} — {{runtime_observability_detail}}
- Config/secrets: {{runtime_config_secrets_presence}} — {{runtime_config_secrets_detail}}
- Documentation: {{runtime_documentation_presence}} — {{runtime_documentation_detail}}
- Release: {{runtime_release_mechanism}} — {{runtime_release_detail}}

For every section flagged `present` or `unknown`, reason explicitly about how this ticket's changes
interact with that concern (data migrations, cache invalidation, telemetry, secrets rotation,
documentation updates, release packaging). Write these considerations into the plan prose so the
extract agent can produce well-grounded `cdotImpact` entries.
