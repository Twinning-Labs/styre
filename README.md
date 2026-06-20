# Styre

The free, open-source execution core of an autonomous-SDLC product. Styre takes a
structured ticket and drives it through `design → implement → verify → review →
merge → released` with minimal human involvement.

**Status:** building the TypeScript substrate (the design is frozen). See the milestone
plan in [`docs/plans/`](docs/plans/).

## Design docs

- Architecture — the frozen substrate spec: [`docs/architecture/`](docs/architecture/)
- Brainstorms: [`docs/brainstorms/`](docs/brainstorms/)
- Plans: [`docs/plans/`](docs/plans/)

## Develop

Requires [Bun](https://bun.sh).

```sh
bun install
bun test
bun run lint
bun run build         # → dist/styre (single self-contained binary)
./dist/styre --version
./dist/styre migrate  # bootstraps the SQLite SoT under $XDG_STATE_HOME/styre/
```
