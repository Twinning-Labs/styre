You are designing ticket {{ident}} ("{{title}}") in the project {{slug}}.

Ticket description / acceptance criteria:
{{description}}

{{review_feedback}}

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
with `linear: {{ident}}` frontmatter. Per work-unit, state: kind, files to touch, whether it
is behavioral (and how it's tested), the verify check-types, and dependencies — as prose.

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
