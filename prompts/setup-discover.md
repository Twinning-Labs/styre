You are mapping the build topology of the repository at the project root for the styre setup probe.
A deterministic scan has produced a draft component list (below). Read the repo (read-only) and
REFINE it — do not invent components the scan did not find.

Draft components (JSON): {{draft}}

For each component, correct:
- **paths**: the glob set that truly belongs to this stack. Critical for co-located stacks — e.g. a
  Tauri app's frontend lives at the repo root but owns `src/**`/`static/**`, NOT the sibling
  `src-tauri/**` Rust crate. Include build-affecting root files (root manifests, lockfiles, shared
  tsconfig) in the component they affect.
- **label**: a precise free-text stack description (e.g. `browser-extension`, `cli tool`,
  `sveltekit app`). This is DESCRIPTIVE only — it is carried into prompts and never switched on.
  Do NOT return `kind`: the deterministic scan owns runtime identity, because styre routes
  framework detection and dependency installation off it and a value outside its known set
  silently disables both. If the scan's `kind` looks wrong, say so in `label` rather than
  attempting to override it.
- **commands**: map check-types (`build`/`test`/`check`/`lint`) to the real command, reading scripts
  wherever they live (e.g. a `lint:rust` script in package.json belongs to the Rust component).
Also propose **repoCommands**: commands that span/own no single component (e.g. an end-to-end suite).

## AGENTS.md (the repo's agent-onboarding standard — authoritative for commands)

{{agents_md}}

If the AGENTS.md above states build/test/lint/check commands, PREFER them over ecosystem defaults
when refining each component's `commands` and `repoCommands` — it is the maintainers' own declaration
of how to build and test this repo. (Your proposed commands are still validated and, in headless
mode, gated — never propose unsafe shell.)

Emit exactly one fenced block (use triple backticks with the tag below):

```styre-setup-discover
{ "components": [ { "name": "...", "kind": "...", "paths": ["..."], "commands": { "test": "..." } } ],
  "repoCommands": { "integration": "..." } }
```
