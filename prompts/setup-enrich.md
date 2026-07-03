You are enriching the runtime-context section of a Styre project profile for the repository at the current working directory. A deterministic scan has already set ground-truth flags from hard signals; your job is to write specific, grounded prose for each section and to resolve sections the scan could not determine. You have read-only tools (Read, Grep, Glob) — open the relevant files to ground your prose. Do NOT write or modify anything.

Deterministic scan results (treat the flags as ground truth — do not contradict a `present`/`absent` flag):

- Topology: {{scan_topology}} — {{scan_topology_detail}}
- Data/persistence: {{scan_data}} — {{scan_data_detail}} (migration tool: {{scan_data_migration_tool}})
- Caching: {{scan_caching}} — {{scan_caching_detail}}
- Observability: {{scan_observability}} — {{scan_observability_detail}}
- Config/secrets: {{scan_config_secrets}} — {{scan_config_secrets_detail}}
- Documentation: {{scan_documentation}} — {{scan_documentation_detail}}
- Release/packaging: {{scan_release}} — {{scan_release_detail}}

For EACH section, write a `detail` string: concrete, specific prose grounded in the actual files (e.g. "Postgres via Prisma; migrations in prisma/migrations; soft-delete columns on users"). Never read secret values — you may note that a `.env.example` exists, but do not open `.env` files.

For any section the scan marked `unknown`, investigate the repo and, if you can determine it, propose a value. For `presence` (data/caching/observability/configSecrets/documentation) use `present` or `absent`. For `topology` set `type`; for release/packaging set `mechanism`. Each of `type` and `mechanism` must be exactly one of the allowed values listed below — never invent a value outside the list. If none of the allowed values fit, use `unknown` and explain what you found in `detail`. Do NOT set presence/type/mechanism for sections the scan already resolved — only enrich their `detail`.

Allowed `topology.type` (choose exactly one, else `unknown`):
`web-service`, `web-n-tier`, `desktop`, `mobile-ios`, `mobile-android`, `browser-extension`, `cli`, `library`, `hybrid`, `unknown`.

Allowed `releasePackaging.mechanism` (choose exactly one, else `unknown`):
`semantic-release`, `app-store`, `installer`, `signed-binary`, `pypi`, `conda`, `npm`, `cargo`, `gem`, `composer`, `maven`, `go-module`, `none`, `unknown`.
When more than one could apply, prefer the release-automation tool if one is configured (e.g. `semantic-release`); otherwise name the target package registry (e.g. `pypi`, `npm`, `cargo`).

Emit exactly one fenced block:

```styre-setup-enrich
{
  "topology": { "type": "cli", "detail": "…" },
  "data": { "presence": "present", "migrationTool": "prisma", "detail": "…" },
  "caching": { "presence": "absent", "detail": "…" },
  "observability": { "detail": "…" },
  "configSecrets": { "detail": "…" },
  "documentation": { "detail": "…" },
  "releasePackaging": { "mechanism": "semantic-release", "detail": "…" }
}
```

Include all seven keys. Only include `presence`/`type`/`mechanism` when you are proposing a value for a section the scan left `unknown`.
