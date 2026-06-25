You are mapping the build topology of the repository at the project root for the styre setup probe.
A deterministic scan has produced a draft component list (below). Read the repo (read-only) and
REFINE it — do not invent components the scan did not find.

Draft components (JSON): {{draft}}

For each component, correct:
- **paths**: the glob set that truly belongs to this stack. Critical for co-located stacks — e.g. a
  Tauri app's frontend lives at the repo root but owns `src/**`/`static/**`, NOT the sibling
  `src-tauri/**` Rust crate. Include build-affecting root files (root manifests, lockfiles, shared
  tsconfig) in the component they affect.
- **kind**: a precise free-text stack label (e.g. `sveltekit`, `rust`, `node`).
- **commands**: map check-types (`build`/`test`/`check`/`lint`) to the real command, reading scripts
  wherever they live (e.g. a `lint:rust` script in package.json belongs to the Rust component).
Also propose **repoCommands**: commands that span/own no single component (e.g. an end-to-end suite).

Emit exactly one fenced block (use triple backticks with the tag below):

```styre-setup-discover
{ "components": [ { "name": "...", "kind": "...", "paths": ["..."], "commands": { "test": "..." } } ],
  "repoCommands": { "integration": "..." } }
```
