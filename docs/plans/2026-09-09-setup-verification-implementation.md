# Setup & Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout: failing test → see it fail → implement → see it pass → lint/typecheck/suite → commit.

**Goal:** Ship the evidence-backed corrective slices for `styre setup`/verify, and stand up the bench scoring path so styre's quality becomes a measured number instead of an argument.

**Architecture:** Three separable bodies of work. **Part 1** unblocks measurement by splitting the bench pipeline — styre runs locally (already works), only the SWE-bench oracle moves to x86-64 Linux via free GitHub Actions. **Part 2** fixes ten defects confirmed by reading code, none of which depends on new architecture. **Part 3** is the agreed qualified-execution contract, which is specified but **not** task-decomposable yet; its entry conditions are stated instead of fabricated tasks.

**Tech Stack:** Bun + TypeScript (styre), Python 3.11 + `swebench==4.1.0` (bench scorer), SQLite, Docker, GitHub Actions.

**Spec:**
- `/Users/rajatgoyal/code/styre-setup-evidence-contract-2026-09-09.md` §20 (the agreed contract) and §19 (28 attributed rounds, including withdrawn reasoning)
- `docs/brainstorms/2026-09-09-setup-python-node-strengthening-design.md` (detector design, v2)

## Global Constraints

- **Never commit to `main`.** Branch per task group; `feat/` for features, `fix/` for fixes. Merge by PR only; the operator merges. No `gh pr merge`, no auto-merge.
- **PR titles are Conventional Commits** (`type(scope): subject`) — enforced by the pr-title check; squash-merge makes the title the changelog line.
- **Two `schema.sql` copies must move together.** `src/db/schema.sql` is authoritative and loaded; `docs/architecture/schema.sql` is the doc copy. Any schema change edits both.
- **`docs/architecture/` is kept current with the code** — a change that alters documented behaviour updates the reference in the same PR.
- **Gates for every task:** `bun test`, `bun run typecheck`, `bun run lint` (biome) all clean. One pre-existing failure is expected in `styre-bench`'s `tests/run-task.test.ts` ("throws when a required cred is missing") — it is environment-dependent and fails identically on clean `main`. No new failures.
- **Verdict inputs are frozen in Part 2.** No task in Part 2 may change what any existing consumer treats as a pass/fail/error input. Task 9 is the boundary case and states its limit explicitly.
- **Evidence discipline:** before asserting something is missing or broken in a commit message or doc, grep for the thing that would refute it. Cite `file:line` and verify the line.

---

# Part 1 — Bench scoring (repo: `styre-bench`)

**Why first:** no styre-bench run has *ever* produced a resolve verdict. Every report on disk reads `resolved: None` / `taxonomy: unscored`; the single `False` is a `blankRecord` default on a `probe` row, not an oracle result. The oracle was attempted once and died on `BuildImageError: Environment image sweb.env.py.x86_64... not found` — an amd64 image on an arm64 host. Until this is fixed, every statement about styre's quality is unmeasured, including the strict-gating policy in Part 3.

**Key insight this part exploits:** scoring does not need styre. `scorer/score.py score` takes `{"instance": {...}, "candidate_diff": "..."}` on stdin and returns `{"resolved": ...}`. The expensive, credentialed half (running styre) stays on macOS where it already works; only the oracle moves to Linux.

### Task 1: Emit a scoreable payload from a completed local run

**Files:**
- Create: `bin/emit-score-payload.ts`
- Create: `tests/emit-score-payload.test.ts`

**Interfaces:**
- Produces: `buildScorePayload(instance: Instance, diff: string): { instance: Instance; candidate_diff: string }` — consumed by Task 2's workflow as a JSON file.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { buildScorePayload } from "../bin/emit-score-payload";

describe("buildScorePayload", () => {
  test("wraps instance and diff in the scorer's stdin shape", () => {
    const inst = { id: "astropy__astropy-12907", language: "python" } as never;
    const p = buildScorePayload(inst, "diff --git a/x b/x\n");
    expect(p.instance).toBe(inst);
    expect(p.candidate_diff).toBe("diff --git a/x b/x\n");
  });

  test("an empty diff is preserved, not omitted", () => {
    // The harness filters empty patches out of its own CLI, which is why the
    // adapter calls run_instance directly. An empty diff must still reach it as
    // an explicit empty string so the result is `resolved: false`, not a crash.
    const p = buildScorePayload({ id: "x", language: "python" } as never, "");
    expect(p.candidate_diff).toBe("");
    expect(Object.hasOwn(p, "candidate_diff")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test tests/emit-score-payload.test.ts`
Expected: FAIL — cannot resolve `../bin/emit-score-payload`.

- [ ] **Step 3: Implement**

```ts
#!/usr/bin/env bun
/**
 * Emits the exact stdin payload `scorer/score.py score` expects, so a diff
 * produced by a local (macOS) styre run can be scored on x86-64 Linux.
 *
 * Usage: bun bin/emit-score-payload.ts <instance-id> <diff-file> > payload.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadInstances } from "../orchestrator/corpus";
import { BENCH_CONFIG } from "../config/bench.config";
import type { Instance } from "../orchestrator/types";

/** PURE. The scorer's stdin contract (`scorer/score.py:_COMMANDS["score"]`). */
export function buildScorePayload(
  instance: Instance,
  diff: string,
): { instance: Instance; candidate_diff: string } {
  return { instance, candidate_diff: diff };
}

async function main(): Promise<void> {
  const [id, diffFile] = process.argv.slice(2);
  if (!id || !diffFile) {
    console.error("usage: bun bin/emit-score-payload.ts <instance-id> <diff-file>");
    process.exit(64);
  }
  const pool = [
    ...(await loadInstances("swe-bench", BENCH_CONFIG)),
    ...(await loadInstances("multi-swe-bench", BENCH_CONFIG)),
  ];
  const instance = pool.find((i) => i.id === id);
  if (!instance) {
    console.error(`no corpus instance with id '${id}'`);
    process.exit(65);
  }
  const diff = readFileSync(diffFile, "utf8");
  writeFileSync(1, `${JSON.stringify(buildScorePayload(instance, diff))}\n`);
}

if (import.meta.main) await main();
```

- [ ] **Step 4: Run the test and see it pass**

Run: `bun test tests/emit-score-payload.test.ts` — expect PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run lint && bun test
git add bin/emit-score-payload.ts tests/emit-score-payload.test.ts
git commit -m "feat(score): emit a scoreable payload from a local run diff"
```

### Task 2: Scoring workflow on GitHub Actions

**Files:**
- Create: `.github/workflows/score.yml`
- Create: `docs/scoring.md`

**Interfaces:**
- Consumes: a `payload.json` from Task 1, supplied as a workflow input or committed under `scoring/`.
- Produces: a job summary line `resolved=true|false` and the raw scorer JSON as an artifact.

**Why GitHub Actions:** `styre-bench` is **public**, so runner minutes are free; `ubuntu-latest` is x86-64 with Docker preinstalled; scoring needs **no secrets** (no agent key, no GitHub token beyond the default). The repo currently has no workflows.

**Known constraint — disk.** SWE-bench environment and instance images are large and the standard runner has roughly 14 GB free. The reclaim step below frees ~25 GB by removing preinstalled toolchains. **Known constraint — network.** `SweBenchAdapter` calls `load_swebench_dataset` to recover `version`/`environment_setup_commit`, so the job needs Hugging Face reachability; this is documented in the adapter's own header.

- [ ] **Step 1: Write the workflow**

```yaml
name: score
on:
  workflow_dispatch:
    inputs:
      instance_id:
        description: "corpus instance id, e.g. astropy__astropy-12907"
        required: true
      payload_path:
        description: "path to a committed payload.json"
        required: true
        default: scoring/payload.json

jobs:
  score:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4

      - name: Reclaim disk
        run: |
          set -euxo pipefail
          df -h /
          sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc \
                      /usr/local/share/boost "$AGENT_TOOLSDIRECTORY" || true
          docker system prune -af || true
          df -h /

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install scorer deps
        run: |
          python -m venv .venv
          ./.venv/bin/pip install --upgrade pip
          ./.venv/bin/pip install -r scorer/requirements.txt

      - name: Score
        id: score
        run: |
          set -euo pipefail
          ./.venv/bin/python scorer/score.py score \
            < "${{ inputs.payload_path }}" > scorer-out.json
          cat scorer-out.json

      - name: Summarise
        if: always()
        run: |
          python - <<'PY' >> "$GITHUB_STEP_SUMMARY"
          import json, pathlib
          p = pathlib.Path("scorer-out.json")
          if not p.exists():
              print("## Scoring failed before producing output"); raise SystemExit(0)
          d = json.loads(p.read_text() or "{}")
          if "error" in d:
              print(f"## Transport failure\n\n`{d['error']}`")
          else:
              print(f"## resolved = `{d.get('resolved')}`\n")
              print("```json"); print(json.dumps(d, indent=2)); print("```")
          PY

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: scorer-output
          path: |
            scorer-out.json
            logs/run_evaluation/**
```

- [ ] **Step 2: Verify the workflow parses**

Run: `gh workflow list` after pushing the branch, or `act -n` if installed.
Expected: the `score` workflow is listed and its `workflow_dispatch` inputs render.

- [ ] **Step 3: Document the two-machine split**

Create `docs/scoring.md` stating: styre runs locally on macOS and produces a diff; `bin/emit-score-payload.ts` turns that diff plus a corpus id into `payload.json`; the `score` workflow runs the oracle on x86-64 Linux; a transport `error` is a harness failure to investigate and is **never** a `resolved: false`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/score.yml docs/scoring.md
git commit -m "ci(score): run the SWE-bench oracle on x86-64 Linux via Actions"
```

- [ ] **Step 5: Acceptance — the first real number**

Take the diff from a completed local `ONLY=astropy__astropy-12907` run, emit a payload, commit it under `scoring/`, dispatch the workflow, and record the result. **This produces styre's first ground-truth verdict.** A transport error here is progress: it names the next blocker.

---

# Part 2 — Confirmed-defect corrective slices (repo: `styre`)

Every defect below was verified by reading code, by both parties in the design exchange. None requires the Part 3 contract. Ordering is forced by dependencies, not severity.

### Task 3: Ordered migrations and a narrowed version read

**Files:**
- Modify: `src/db/migrate.ts:12-40`
- Create: `test/db/migrate-ordered.test.ts`

**Interfaces:**
- Produces: `MAX_KNOWN_SCHEMA_VERSION: number`, `migrate(path: string): MigrateResult` (unchanged signature, new behaviour on an existing database).

**The defect:** `readVersion` returns `null` inside a bare `catch`, commented "schema_meta table absent → fresh DB" (`migrate.ts:19-21`). **Any** failure — corruption, lock, permission, I/O — is therefore indistinguishable from a fresh database, after which `migrate` attempts bootstrap against a database that may be intact. Bootstrap uses 17 plain `CREATE TABLE` statements with no `IF NOT EXISTS`, so it fails loudly rather than erasing — data loss is *not* demonstrated — but attempting writes on an unreadable database is still wrong, and the early return at `:29-31` means `migrate` is a bootstrap routine, not an upgrade path.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_KNOWN_SCHEMA_VERSION, migrate } from "../../src/db/migrate.ts";

function tmpDb(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "styre-mig-")), name);
}

describe("migrate: ordered upgrades and safe version reads", () => {
  test("a fresh path bootstraps and reports created", () => {
    const r = migrate(tmpDb("fresh.db"));
    expect(r.created).toBe(true);
    expect(r.version).toBe(MAX_KNOWN_SCHEMA_VERSION);
  });

  test("re-running on a current database is a no-op, not a bootstrap", () => {
    const p = tmpDb("again.db");
    migrate(p);
    const r = migrate(p);
    expect(r.created).toBe(false);
    expect(r.version).toBe(MAX_KNOWN_SCHEMA_VERSION);
  });

  test("a database whose version exceeds this binary's maximum is REFUSED", () => {
    const p = tmpDb("newer.db");
    migrate(p);
    const db = new Database(p);
    db.run("INSERT INTO schema_meta (version, applied_at, note) VALUES (?, ?, ?)", [
      MAX_KNOWN_SCHEMA_VERSION + 1,
      new Date().toISOString(),
      "written by a newer binary",
    ]);
    db.close();
    expect(() => migrate(p)).toThrow(/newer than this binary supports/);
  });

  test("a corrupt database is refused, never treated as fresh", () => {
    const p = tmpDb("corrupt.db");
    writeFileSync(p, "this is not a sqlite file at all");
    expect(() => migrate(p)).toThrow();
  });

  test("schema_meta present but empty is refused rather than bootstrapped over", () => {
    const p = tmpDb("empty-meta.db");
    const db = new Database(p, { create: true });
    db.run("CREATE TABLE schema_meta (version INTEGER NOT NULL, applied_at TEXT NOT NULL, note TEXT)");
    db.close();
    expect(() => migrate(p)).toThrow(/schema_meta exists but records no version/);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test test/db/migrate-ordered.test.ts`
Expected: the refusal tests FAIL (current code returns `null` and bootstraps or early-returns).

- [ ] **Step 3: Implement**

```ts
/** The highest schema version this binary understands. A database above it is refused
 *  (the compatibility fence): an older binary must never silently misread a newer store. */
export const MAX_KNOWN_SCHEMA_VERSION = 8;

interface Migration {
  version: number;
  apply(db: Database): void;
}

/** Ordered upgrades, applied in version order, each in its own transaction. Append only. */
const MIGRATIONS: Migration[] = [];

/** Distinguish "no schema_meta table" (a genuinely fresh database) from every other
 *  failure. The old bare catch made corruption, locks and permission errors all look
 *  fresh, after which bootstrap was attempted against a possibly-intact database. */
function readVersion(db: Database): number | null {
  const present = db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_meta'",
    )
    .get();
  if (present === null || present.n === 0) return null; // fresh
  const row = db
    .query<{ version: number }, []>("SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1")
    .get();
  if (row === null) {
    throw new Error(
      "migrate: schema_meta exists but records no version — refusing to bootstrap over it.",
    );
  }
  return row.version;
}

export function migrate(path: string): MigrateResult {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    const existing = readVersion(db);
    if (existing === null) {
      applySchema(db);
      return { version: MAX_KNOWN_SCHEMA_VERSION, created: true };
    }
    if (existing > MAX_KNOWN_SCHEMA_VERSION) {
      throw new Error(
        `migrate: database schema version ${existing} is newer than this binary supports ` +
          `(max ${MAX_KNOWN_SCHEMA_VERSION}). Upgrade styre; this binary will not modify it.`,
      );
    }
    for (const m of MIGRATIONS.filter((m) => m.version > existing).sort((a, b) => a.version - b.version)) {
      db.transaction(() => {
        m.apply(db);
        db.run("INSERT INTO schema_meta (version, applied_at, note) VALUES (?, ?, ?)", [
          m.version,
          new Date().toISOString(),
          `migration ${m.version}`,
        ]);
      })();
    }
    return { version: readVersion(db) ?? existing, created: false };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run and see them pass**

Run: `bun test test/db/migrate-ordered.test.ts` — expect PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun test && bun run typecheck && bun run lint
git add src/db/migrate.ts test/db/migrate-ordered.test.ts
git commit -m "fix(db): ordered migrations and a version read that refuses unreadable databases"
```

**Note on the fence:** shipping `MAX_KNOWN_SCHEMA_VERSION` is only half of it. The *supported rollback floor* is the set of released binaries that carry this check. Development and testing of later schema work may proceed before that floor exists; **activation** of anything that writes a higher version must not. Record the floor's release identifier in `docs/architecture/runtime-parameters.md` when it ships.

### Task 4: Read-only database opener

**Files:**
- Modify: `src/db/client.ts:1-20`
- Create: `test/db/open-readonly.test.ts`

**Interfaces:**
- Produces: `openDbReadOnly(path: string): Database` — opens without creating and without setting WAL, for inspection and compatibility checks before any write.

**The defect:** `openDb` creates the file and sets WAL (`client.ts:4`), so there is no way to inspect a database — for a version check, or for `styre run --inspect` — without mutating it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbReadOnly } from "../../src/db/client.ts";

describe("openDbReadOnly", () => {
  test("does not create a missing database", () => {
    const p = join(mkdtempSync(join(tmpdir(), "styre-ro-")), "absent.db");
    expect(() => openDbReadOnly(p)).toThrow();
    expect(existsSync(p)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see it fail** — `openDbReadOnly` is not exported.

- [ ] **Step 3: Implement**

```ts
/** Open an EXISTING database for inspection only: never creates, never sets WAL,
 *  never writes. Used by compatibility/version checks and `--inspect` before any
 *  decision to migrate or resume. `openDb` remains the read-write path. */
export function openDbReadOnly(path: string): Database {
  return new Database(path, { readonly: true, create: false });
}
```

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Commit**

```bash
git add src/db/client.ts test/db/open-readonly.test.ts
git commit -m "feat(db): add a read-only opener for pre-migration inspection"
```

### Task 5: Typed test identity — the nested-path defect

**Files:**
- Create: `src/dispatch/test-arg.ts`
- Create: `test/dispatch/test-arg.test.ts`
- Modify: `src/dispatch/handlers.ts:664` (authoring), `src/dispatch/post-implement-rerun.ts:40`, `src/dispatch/replay-harness.ts:78`

**Interfaces:**
- Produces: `testArgFor(testPath: string, componentDir: string | undefined): string`
- Consumes: nothing from other tasks.

**The defect, confirmed by both parties.** `testPath` originates from `git diff-tree` output and is **repository-root-relative** (`handlers.ts:619` via `resolveAuthoredTestPath`). `buildCheckSelector` emits `shq(\`${testFile}::${testName}\`)` with **no cwd transformation** (`check-selector.ts:118`), while execution cwd is `join(worktreePath, comp.dir ?? "")` (`handlers.ts:670`). For `comp.dir = "services/api"` the argument addresses `<wt>/services/api/services/api/tests/…`. Go doubles identically via `./${dirname(testFile)}` (`check-selector.ts:131`).

**The same field is consumed root-relative elsewhere**: `fileContentAt(sha, check.test_path, worktreePath)` runs `git show <sha>:<file>` from the worktree **root** (`check-integrity.ts:55`, `worktree.ts:290`). One stored field, two incompatible frames, both reachable from `verify:checks-gate`. **So `test_path` must stay repo-relative in storage** and the execution argument must be derived.

**Prevalence:** 198 of 224 Multi-SWE-bench instances (88.4% instance-weighted, 2 of 3 repositories) have failing tests under a `packages/` segment. Masked for Python because `pythonDef` pushes a root `**` component *before* nested ones and `impactedComponents(...)[0]` takes the first match (`handlers.ts:633`, `components.ts:86`) — so the root wins and cwd is the worktree root. `nodeDef`'s root paths are narrow, so nested packages *are* selected and the doubling fires.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { testArgFor } from "../../src/dispatch/test-arg.ts";

describe("testArgFor", () => {
  test("root component: the repo-relative path is already correct", () => {
    expect(testArgFor("tests/test_thing.py", undefined)).toBe("tests/test_thing.py");
    expect(testArgFor("tests/test_thing.py", "")).toBe("tests/test_thing.py");
  });

  test("nested component: the argument is relative to the component dir", () => {
    expect(testArgFor("services/api/tests/feature_test.py", "services/api")).toBe(
      "tests/feature_test.py",
    );
  });

  test("nested component with a trailing slash on dir", () => {
    expect(testArgFor("packages/ui/src/a.test.ts", "packages/ui/")).toBe("src/a.test.ts");
  });

  test("a path outside the component dir THROWS rather than deriving a wrong target", () => {
    // This is the component mis-selection case. Producing any argument here would
    // silently run the wrong file (or nothing); refusing surfaces the real defect.
    expect(() => testArgFor("other/tests/x_test.py", "services/api")).toThrow(
      /not under component dir/,
    );
  });

  test("a dir that is a string prefix but not a path segment does not match", () => {
    expect(() => testArgFor("services/apixyz/t_test.py", "services/api")).toThrow(
      /not under component dir/,
    );
  });
});
```

- [ ] **Step 2: Run and see it fail** — module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * PURE. Derive the cwd-relative test argument from the stored repository-relative
 * test identity, for a component whose commands run in `join(worktree, comp.dir)`.
 *
 * `ac_check.test_path` is stored repo-relative because `check-integrity.ts` consumes
 * it that way through `git show <sha>:<path>` from the worktree root. Execution runs
 * in the component dir, so the argument must be relative to THAT. Storing one frame
 * and executing in the other is the nested-path defect.
 *
 * Refuses rather than guessing when the path is not under the component dir: that
 * means the check's component was mis-selected, and any derived argument would run
 * the wrong target while looking successful.
 */
export function testArgFor(testPath: string, componentDir: string | undefined): string {
  if (componentDir === undefined || componentDir === "") return testPath;
  const dir = componentDir.endsWith("/") ? componentDir.slice(0, -1) : componentDir;
  const prefix = `${dir}/`;
  if (!testPath.startsWith(prefix)) {
    throw new Error(
      `testArgFor: '${testPath}' is not under component dir '${dir}' — the check's ` +
        "component was mis-selected; refusing to derive a target that would run the wrong file.",
    );
  }
  return testPath.slice(prefix.length);
}
```

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Wire the three consumers**

At `handlers.ts:664`, `post-implement-rerun.ts:40` and `replay-harness.ts:78`, pass the derived argument to `buildCheckSelector` while leaving the **stored** `testPath` untouched:

```ts
const sel = buildCheckSelector(fw, {
  testFile: testArgFor(testPath, comp.dir),
  testName: c.test_name,
});
```

- [ ] **Step 6: Add a nested-component regression test**

`test/dispatch/replay-harness.test.ts` currently documents its own root-only assumption at `:101` ("`PY` sets no `dir`, so `cwd` is the worktree ROOT"). Add a sibling fixture whose component sets `dir: "services/api"`, and assert the **resolved target** — not that several callers agree.

- [ ] **Step 7: Gates and commit**

```bash
bun test && bun run typecheck && bun run lint
git add src/dispatch/test-arg.ts test/dispatch/test-arg.test.ts src/dispatch/handlers.ts \
        src/dispatch/post-implement-rerun.ts src/dispatch/replay-harness.ts \
        test/dispatch/replay-harness.test.ts
git commit -m "fix(checks): derive cwd-relative test arguments from repo-relative identity"
```

### Task 6: Atomic profile publication

**Files:**
- Modify: `src/cli/setup.ts:176-177`
- Create: `test/cli/write-profile-atomic.test.ts`

**Interfaces:**
- Produces: `writeProfileAtomic(outPath: string, contents: string): void`

**The defect:** publication is a bare `writeFileSync(outPath, …)` — not atomic, so a crash mid-write leaves a torn `profile.json` that `parseProfile` will reject on the next run. **This is atomic visibility only.** It does not solve concurrent publication (two setups sharing `--out` can still lose an update); that needs the lease and compare-and-swap in Part 3, and this task must not claim otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfileAtomic } from "../../src/cli/setup.ts";

describe("writeProfileAtomic", () => {
  test("replaces existing content and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "styre-pub-"));
    const out = join(dir, "profile.json");
    writeFileSync(out, "{\"old\":true}\n");
    writeProfileAtomic(out, "{\"new\":true}\n");
    expect(readFileSync(out, "utf8")).toBe("{\"new\":true}\n");
    expect(readdirSync(dir)).toEqual(["profile.json"]);
  });

  test("creates the file when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "styre-pub-"));
    const out = join(dir, "profile.json");
    writeProfileAtomic(out, "{}\n");
    expect(readFileSync(out, "utf8")).toBe("{}\n");
  });
});
```

- [ ] **Step 2: Run and see it fail** — not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Publish the profile atomically: write a sibling temp file, flush it, rename over
 * the target, then flush the containing directory so the rename itself is durable.
 * A crash at any point leaves either the old profile or the new one, never a torn file.
 *
 * ATOMIC VISIBILITY ONLY. This does not coordinate concurrent publishers — two
 * setups sharing an `--out` path can still lose an update. Coordinated publication
 * (lease + compare-and-swap on the accepted revision) is Part 3.
 */
export function writeProfileAtomic(outPath: string, contents: string): void {
  const dir = dirname(outPath);
  const tmp = join(dir, `.${basename(outPath)}.${randomUUID()}.tmp`);
  writeFileSync(tmp, contents);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, outPath);
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
```

Replace the call site at `setup.ts:177` with `writeProfileAtomic(outPath, \`${JSON.stringify(profile, null, 2)}\n\`)`.

- [ ] **Step 4: Run and see it pass.**

- [ ] **Step 5: Commit**

```bash
git add src/cli/setup.ts test/cli/write-profile-atomic.test.ts
git commit -m "fix(setup): publish profile.json atomically (visibility only)"
```

### Task 7: Node detector — use the resolved package manager everywhere

**Files:**
- Modify: `src/setup/lang/node.ts:7-50`
- Modify: `src/setup/registry.ts` (no change expected; verify)
- Modify: `src/dispatch/provision.ts:18` (bun marker)
- Modify: `test/setup/lang-node.test.ts`

**The defects:**
- **D4** — `nodePrepare` resolves yarn/pnpm/npm from lockfiles (`node.ts:7-12`) and the commands then hardcode `npm run` (`node.ts:32-34`). Install and run disagree.
- **D13** — `src/setup/detect.ts` **already contains** `detectPackageManager` (handling bun, pnpm, yarn, npm) and `detectCommands` emitting `` `${pm} run ${name}` `` over `KNOWN_SCRIPTS = ["test","build","lint","typecheck"]`. `probe.ts:6` imports only `detectChecksSystem`; the rest is dead. `node.ts` reimplemented a worse duplicate.
- **D15** — `nodePrepare` has **no `bun.lock` branch at all**, and `NODE_INSTALL_MARKERS` (`provision.ts:18`) has no bun entry.

**Ordering constraint:** add bun's completeness marker to `NODE_INSTALL_MARKERS` in the **same commit** as the bun install branch. A bun branch without a marker makes `isComponentReady` return `false` forever — a deterministic reinstall-every-provision regression, not a risk.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeDef } from "../../src/setup/lang/node.ts";

function repo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "styre-node-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(d, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return d;
}

const PKG = JSON.stringify({ scripts: { build: "x", test: "y", lint: "z", typecheck: "w" } });

describe("nodeDef: manager consistency", () => {
  test("pnpm lockfile drives BOTH prepare and the run commands", () => {
    const d = repo({ "package.json": PKG, "pnpm-lock.yaml": "" });
    const [c] = nodeDef.detect(d);
    expect(c.prepare).toBe("pnpm install --frozen-lockfile");
    expect(c.commands.test).toBe("pnpm run test");
    expect(c.commands.build).toBe("pnpm run build");
  });

  test("bun lockfile is detected and produces a bun install", () => {
    const d = repo({ "package.json": PKG, "bun.lock": "" });
    const [c] = nodeDef.detect(d);
    expect(c.prepare).toBe("bun install --frozen-lockfile");
    expect(c.commands.test).toBe("bun run test");
  });

  test("the packageManager field wins over a lockfile", () => {
    const d = repo({
      "package.json": JSON.stringify({ packageManager: "yarn@4.1.0", scripts: { test: "y" } }),
      "package-lock.json": "",
    });
    const [c] = nodeDef.detect(d);
    expect(c.commands.test).toBe("yarn run test");
  });

  test("lint and typecheck scripts are detected, not only build/test/check", () => {
    const d = repo({ "package.json": PKG });
    const [c] = nodeDef.detect(d);
    expect(c.commands.lint).toBe("npm run lint");
    expect(c.commands.typecheck).toBe("npm run typecheck");
  });
});
```

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement**

Replace `nodePrepare` and the command block in `node.ts` with the resolved-manager form, reusing `detectPackageManager` from `../detect.ts` extended with the `packageManager` field:

```ts
import { detectPackageManager, type PackageManager } from "../detect.ts";

const INSTALL: Record<PackageManager, (hasLock: boolean) => string> = {
  bun: () => "bun install --frozen-lockfile",
  pnpm: () => "pnpm install --frozen-lockfile",
  yarn: () => "yarn install --frozen-lockfile",
  npm: (hasLock) => (hasLock ? "npm ci" : "npm install"),
};

/** Script names read per gate, in preference order. `test:ci` is deliberately excluded:
 *  it routinely expects a server or CI environment that setup has not established. */
const GATE_SCRIPTS: Record<string, string[]> = {
  build: ["build"],
  test: ["test", "test:unit"],
  lint: ["lint", "lint:js"],
  typecheck: ["typecheck", "type-check"],
};
```

- [ ] **Step 4: Add bun's marker in the same change**

`provision.ts:18` — append bun's `node_modules` completeness marker to `NODE_INSTALL_MARKERS`. **Verify the actual filename bun writes** on a real `bun install` before committing; do not guess it.

- [ ] **Step 5: Run and see them pass; gates; commit**

```bash
bun test && bun run typecheck && bun run lint
git add src/setup/lang/node.ts src/dispatch/provision.ts test/setup/lang-node.test.ts
git commit -m "fix(setup): use the resolved package manager for install and run commands"
```

### Task 8: Python detector — lint, typecheck and the environment ladder

**Files:**
- Modify: `src/setup/lang/python.ts`
- Modify: `test/setup/lang-python.test.ts`

**The defects:**
- **D1** — `pythonDef` sets `commands: { test: … }` only (`python.ts:93`, `:111`). It never emits `build`, `lint` or `typecheck`. *Scoped claim:* those slots then depend entirely on agent refinement being proposed and accepted, or on an interactive operator — `mergeComponents` merges agent commands (`discover-schema.ts:41`) and `resolveCommands` accepts an operator answer (`resolve-commands.ts:25`). They are **not** permanently unavailable; the scanner simply never fills them.
- **D2** — `pythonTestCommand` chooses from four `existsSync` calls and reads `pyproject.toml` only for `/\[tool\.pytest/` **presence**. No `testpaths`, no `addopts`, no `setup.cfg`, no uv/hatch/pdm.
- **D3** — `pythonPrepare` emits `pip install -e .` with no extras; `[project.optional-dependencies]` is never read.

**Explicitly NOT in this task:** rewriting the test command from `testpaths`. pytest already reads `testpaths` from rootdir config when invoked with no path arguments, so transcribing it into the command string buys nothing — and astropy's own `[tool:pytest]` may declare exactly the two paths that appeared in the failing command. Record `testpaths` and `addopts` as **evidence**, not as a command rewrite.

- [ ] **Step 1: Write the failing tests**

```ts
describe("pythonDef: lint and typecheck detection", () => {
  test("[tool.ruff] in pyproject yields a lint command", () => {
    const d = repo({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
    const [c] = pythonDef.detect(d);
    expect(c.commands.lint).toBe("ruff check .");
  });

  test("[tool.mypy] yields a typecheck command", () => {
    const d = repo({ "pyproject.toml": "[tool.mypy]\nstrict = true\n" });
    const [c] = pythonDef.detect(d);
    expect(c.commands.typecheck).toBe("mypy .");
  });

  test("no linter configured yields no lint command (absent, not unavailable)", () => {
    const d = repo({ "pyproject.toml": "[project]\nname = 'x'\n" });
    const [c] = pythonDef.detect(d);
    expect(c.commands.lint).toBeUndefined();
  });
});

describe("pythonDef: prepare includes declared test extras", () => {
  test("a `test` extra is installed with the package", () => {
    const d = repo({
      "pyproject.toml": "[project]\nname='x'\n[project.optional-dependencies]\ntest=['pytest']\n",
    });
    const [c] = pythonDef.detect(d);
    expect(c.prepare).toBe('pip install -e ".[test]"');
  });

  test("uv.lock selects uv sync over pip", () => {
    const d = repo({ "pyproject.toml": "[project]\nname='x'\n", "uv.lock": "" });
    const [c] = pythonDef.detect(d);
    expect(c.prepare).toBe("uv sync --frozen");
  });
});
```

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** the environment ladder (`uv.lock` → `poetry.lock` → `pdm.lock` → `pyproject.toml` → `requirements*.txt`, with `tox.ini`/`noxfile.py` checked first as today) and the lint/typecheck config detection.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit**

```bash
git add src/setup/lang/python.ts test/setup/lang-python.test.ts
git commit -m "feat(setup): detect Python lint/typecheck and install declared test extras"
```

### Task 9: Bounded log capture — storage only, verdict inputs frozen

**Files:**
- Modify: `src/util/run-command.ts`
- Create: `test/util/run-command-logs.test.ts`

**The defect:** `run-command.ts` returns empty stdout/stderr on timeout and never drains the pipes — deliberately, because the documented promptness property depends on not draining. So a timed-out check yields no diagnostics at all.

**THE BOUNDARY, and it is the whole task.** Streaming bounded output to a file during execution is safe **only while nothing downstream reads it**. The authoring miss-path keys on an error that "produced no output" and then `continue`s to the uncovered branch (`handlers.ts:737-739`). Feeding partial output into that same error **moves it out of the uncovered branch** — a verdict change disguised as logging. `checks-run.ts` also drops the `timedOut` field today.

**This task stores logs and changes no consumer.** Wiring them into verdicts requires typed completion status propagated through `checks-run.ts`, `classify-prior.ts` and the routing in `post-implement-rerun.ts`, and belongs with Part 3's typed-completion work.

- [ ] **Step 1: Write the failing test**

```ts
test("a timed-out command still leaves partial output on disk", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "styre-log-")), "out.log");
  const res = await runCommand("echo hello && sleep 30", { cwd: process.cwd(), timeoutMs: 500, logPath });
  expect(res.timedOut).toBe(true);
  expect(res.stdout).toBe("");                       // UNCHANGED: consumers see nothing new
  expect(readFileSync(logPath, "utf8")).toContain("hello");
});
```

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement** an optional `logPath` that streams to a bounded file, leaving the returned `stdout`/`stderr` exactly as today.
- [ ] **Step 4: Run and see it pass.**
- [ ] **Step 5: Add the guard test**

```ts
test("returned stdout stays empty on timeout so no verdict input changes", async () => {
  const res = await runCommand("echo hi && sleep 30", { cwd: process.cwd(), timeoutMs: 300, logPath });
  expect(res.stdout).toBe("");
  expect(res.stderr).toBe("");
});
```

- [ ] **Step 6: Commit**

```bash
git add src/util/run-command.ts test/util/run-command-logs.test.ts
git commit -m "feat(exec): persist bounded logs on timeout without changing verdict inputs"
```

### Task 10: Reject an agent command that collects nothing

**Files:**
- Modify: `src/setup/discover.ts:63`, `src/setup/discover-schema.ts:55-68`
- Create: `test/setup/discover-collect-gate.test.ts`

**The defect — this is the actual astropy cause.** `discover.ts:63` accepts an agent proposal on `isCommandSafe && probeCommandExists && trusted`. None asks whether the command produces a usable signal. And `probeCommandExists` special-cases `^npm run` and otherwise falls back to `command -v <first token>` (`discover-schema.ts:57`), so `tsc --noEmit` and `eslint .` — valid devDependency invocations — are **rejected** for not being global, while `pnpm run lint` is accepted whenever `pnpm` exists regardless of whether the script does. Neither warning branch fires for a probe-only failure, so the rejection is silent.

- [ ] **Step 1: Fix the probe first** — teach it each resolved manager's script list and `node_modules/.bin`, with tests for `pnpm run <absent-script>` (reject) and `tsc --noEmit` with a local install (accept).
- [ ] **Step 2: Add the emptiness gate** — reject a proposed test command whose bounded collection probe reports zero collected items. **Reject on "collects zero", never on "exits non-zero"**: a command that runs and fails is darkreader, and judging that is the differential design's job.
- [ ] **Step 3: Make every rejection loud** — the silent probe-only path must emit a warning naming the command and the reason.
- [ ] **Step 4: Commit**

```bash
git commit -m "fix(setup): reject agent commands that collect nothing, and fix the existence probe"
```

### Task 11: Discovery before build in provision

**Files:**
- Modify: `src/dispatch/provision.ts:34,60`, `src/dispatch/reuse.ts`
- Create: `test/dispatch/provision-discovery.test.ts`

**The defects:**
- **D10** — `isComponentReady` returns `false` for every kind but node/sveltekit (`provision.ts:34`), so `pip install -e .` runs on every provision, including over a prepared conda environment that already has the package installed correctly.
- **D11** — the reuse probe runs at **verify** time (`handlers.ts:1344`, `:1521`), after provision already reinstalled. The resolver gates provision first (`resolver.ts:134-142`). The cheap check follows the expensive one.

**Design (from the brainstorm v2, §P3.1/P3.2).** Split the probe's two questions:
- **Q1, the correctness precondition** — does `import <name>` resolve **under the component dir**, checked from a tempdir outside it so `sys.path[0]` cannot false-pass a shadowed copy? Only Q1 gates reuse.
- **Q2, the readiness observation** — does the suite collect? Informative; gates nothing.

| Q1 | Q2 | Action |
|---|---|---|
| pass | pass | skip `prepare` entirely |
| pass | fail | **bounded additive repair**, retried exactly once — never a rebuild |
| fail | — | full build path, as today |

The repair must be additive, idempotent and attempted once; a second failure records the reason and continues. **Its exact per-manager form is undesigned** — determine it during implementation and do not write `pip install -e ".[test]"` into a commit without verifying it is additive on a prepared conda environment.

- [ ] **Step 1–5:** tests for each row of the table with a stubbed runner, then implementation, then one real integration test — Q1's correctness property (source under test, not a shadowing copy) is precisely what a stub cannot exercise, so use `pythonEnvReady`'s tempdir-outside-the-worktree technique.

```bash
git commit -m "fix(provision): discover a usable environment before rebuilding it"
```

### Task 12 (coupled, larger): Launcher qualification

**Files:** `src/dispatch/check-selector.ts:396-419`, `src/dispatch/checks-run.ts`, `src/dispatch/tool-allowlists.ts`, `src/dispatch/components.ts:91`

**The defect:** `binaryFor` returns bare `jest`, `vitest`, `phpunit`, `rspec`, `mvn`, `gradle`. `runCheckForRed` executes `<binary> <runArgs>` through `sh -c` with `verifyEnv(process.env)` — no `node_modules/.bin` or `vendor/bin` on PATH. Meanwhile the PHP detector emits `./vendor/bin/phpunit` and `collectToolProbes` deliberately does not preflight build/test/check for prepare-bearing components. On a stock Composer repo the runner executes `phpunit` → 127 → `error`. **And `checks:dispatch` scopes the authoring agent's Bash to the *profile's* command**, so the agent is authorized for a wrapper the runner will not use and forbidden the binary it will — an authorization/execution divergence, not only a launch failure.

**Why this is not a small task.** The launcher must come from the component's qualified action, and a missing launcher must be a typed **unsupported capability**, never a check verdict. Selection transformations and the allowlist must change together. Do not "demote `binaryFor` to a fallback" — that reintroduces the unqualified runtime path the contract forbids.

**Entry condition:** Task 5 landed (so the argument frame is correct before the launcher changes).

### Task 13 (coupled, larger): Typed prerequisite outcome for replay

**Files:** `src/dispatch/replay-harness.ts:68-93`, `src/dispatch/handlers.ts:279`, plus routing, persistence and resume

**The defect:** `replayCheckAtBaseline` creates a detached worktree, overlays one file and runs the check — **no provision, no `node_modules`, no `vendor/`, no editable install**. The caller's contract is "coarse == red installs; everything else rejects" (`handlers.ts:279`), so the oracle is systematically biased toward not-red for stacks needing materialization, producing silent false escalates.

**Why a new return value alone changes nothing:** `unmaterialized` still lands in "everything else" and still rejects. A prerequisite outcome must propagate through the reauthor result, routing, persistence and resume, and must not spend a code-blame retry when prerequisites are merely unknown. Also, absence of an install step is not proof an environment is absent — ambient tools or Go's toolchain can suffice. Distinguish unknown readiness, observed prerequisite failure, and unsupported reconstruction.

**Entry condition:** Part 3's typed completion/routing work, or an explicitly scoped subset agreed first.

---

# Part 3 — The qualified execution contract

**Status: agreed, specified, and deliberately NOT task-decomposed here.**

The full contract is `styre-setup-evidence-contract-2026-09-09.md` §20, agreed across 28 attributed rounds with independent adversarial review on both sides. It covers execution authority, context/action/check/observation records, resource ownership and leases, cancellation and compensation, coordinated publication, strict-green-v1 policy, four first-stack adapters, and a qualification matrix.

**Why there are no tasks for it.** Writing bite-sized TDD tasks would require inventing detail the design does not yet fix — exact table shapes, adapter flags, supervisor APIs. The contract itself flags several of these as needing verification rather than recall (Jest/Vitest list-mode flags, bun's install marker, the per-manager repair form). Fabricating tasks over them would reproduce the exact failure this plan's Global Constraints forbid.

**Entry conditions, all of which are met by Part 2 or Part 1:**

1. **Task 3 and Task 4 shipped**, and the compatibility fence present in a released binary before anything writes a higher schema version. Development and testing of Part 3 code may proceed before that; *activation* may not.
2. **At least one scored bench run** (Part 1, Task 2 Step 5). Strict-green-v1 is a policy about regressions; nobody has yet measured styre's resolve rate, false-pass rate, or how often its changes break unrelated code. Specifying enforcement for an unmeasured phenomenon is the largest unhedged risk in the whole programme.
3. **One stack end to end before four stacks partially.** Python first: it is the bench corpus, it holds the prepared-conda case, and it is where the astropy evidence came from.

**Infrastructure this part needs, which Part 1 does not.** The qualification matrix includes reboot fixtures ("same-domain reboot with a dirty install"), surviving-child, PID reuse and cgroup-v2 delegation. **These cannot run on ephemeral CI** — you cannot reboot a GitHub runner and observe boot-identity continuity. They need a persistent x86-64 Linux host you control. Cheapest with an automation API is Hetzner Cloud's shared-vCPU line (verify current pricing; figures move), provisioned by `hcloud` or Terraform with cloud-init installing Docker and Bun, destroyable between sessions. Everything stateless stays on free Actions minutes.

---

## Epistemic status — read before prioritising

Two bodies of work with very different evidence behind them:

**Verified by reading code both parties checked** — Part 2 in its entirety. The nested-path doubling and its two path frames; `readVersion`'s broad catch; `migrate` as bootstrap-not-upgrade; the orphaned `detect.ts`; `frameworkFor` returning `null` for bare `npm test`; the integration sweep's fixed list and early break; `isComponentReady`'s kind allowlist; the reuse probe running after provision; `binaryFor`'s bare binaries; `replayCheckAtBaseline`'s bare worktree; `runStep` keying its cache on the step key; `setup.ts`'s bare write. Each carries a file and line, and each was checked by both parties.

**Argued and reviewed but entirely unbuilt** — Part 3. No fixture has run, no cost figure exists, no runtime incidence of the nested chain has been observed, and every claim about how the contract behaves once implemented is an argument from stated mechanism.

**Measured** — exactly two things. The corpus nesting counts (198/224 instance-weighted, 2 of 3 repository-weighted) and the fact that no bench run has ever produced a resolve verdict.

## Self-review

**Spec coverage.** Part 1 covers the scoring gap. Part 2 covers D1–D15 from the brainstorm plus the four confirmed defects from the design exchange: typed paths (Task 5), launcher (Task 12), replay materialization (Task 13), timeout diagnostics (Task 9). Contract §20 is covered by Part 3's entry conditions rather than tasks, stated as a deliberate scope decision.

**Placeholder scan.** Tasks 1–11 carry real test code and real implementations. Tasks 12 and 13 are deliberately specified as coupled work with entry conditions and no fabricated steps — they are scoped, not stubbed. Three items are explicitly marked "verify, do not guess": bun's install marker, the per-manager repair command, and any framework list-mode flag.

**Type consistency.** `testArgFor(testPath, componentDir)` is used identically in Task 5's three call sites. `writeProfileAtomic(outPath, contents)` matches its call site. `MAX_KNOWN_SCHEMA_VERSION` is defined in Task 3 and referenced in Task 3's tests only. `openDbReadOnly(path)` is defined in Task 4 and consumed by Part 3's compatibility path, not by Part 2.
