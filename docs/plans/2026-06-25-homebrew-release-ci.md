# Homebrew Release CI + Dedicated Tap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a human-triggered release engine for `styre` that auto-computes the version + changelog, builds four native platform binaries, publishes a GitHub Release, and bumps a dedicated Homebrew tap — so users can `brew install twinning-labs/styre`.

**Architecture:** A `workflow_dispatch`-only `release.yml` pins the whole release to one immutable dispatch SHA. git-cliff computes the next semver + `CHANGELOG.md` from Conventional Commits. A 4-job native-per-arch matrix builds and `--version`-smokes each slice. A publish gate (gated on all 4 builds) fast-forward-commits the changelog to `main`, tags, creates the Release, and bumps the tap — each effect made idempotent by probe-then-apply (CL-3), so a re-run heals partial failures instead of cementing them. An org GitHub App mints short-lived, repo-scoped tokens for every push.

**Tech Stack:** GitHub Actions, Bun (`bun build --compile`), git-cliff, `actions/create-github-app-token`, `amannn/action-semantic-pull-request`, Homebrew (tap formula), TypeScript release-tooling scripts tested with `bun:test`.

**Design spec:** `docs/brainstorms/2026-06-25-homebrew-distribution-release-ci-design.md` (read it; this plan implements it).

## Global Constraints

Every task implicitly includes these. Exact values copied from the spec:

- **First release version:** `v0.1.0`. No tags exist yet. `package.json` is pinned at `0.0.0` and must never ship in a released binary.
- **Version bumping (non-default — must be configured):** `feat:`→minor, `fix:`/`chore:`→patch, `BREAKING CHANGE:`→**major** even while pre-1.0. git-cliff defaults to minor pre-1.0, so `cliff.toml` must set `breaking_always_bump_major = true`.
- **Native-per-arch runners (exact labels):** `macos-14` (darwin-arm64), `macos-13` (darwin-x64), `ubuntu-latest` (linux-x64), `ubuntu-24.04-arm` (linux-arm64). Every slice is `styre --version`-smoked on its own arch before publish.
- **Artifact filename template (single source):** `styre-v<version>-<os>-<arch>.tar.gz` + a sibling `.sha256`, where `<os> ∈ {darwin, linux}`, `<arch> ∈ {arm64, x64}`. Build step and formula renderer share one implementation.
- **Auth:** org GitHub App `styre-release-bot`. Mint short-lived installation tokens via `actions/create-github-app-token` — one scoped to `styre` (FF commit + tag + Release create), one scoped to `homebrew-styre` (tap bump). Never a PAT, never `GITHUB_TOKEN` for cross-repo writes. Tokens minted in the publish job only.
- **Branch protection (already configured + verified 2026-06-25):** `styre-release-bot` is the sole PR-bypass actor on `main`; `allow_force_pushes=false`; `required_linear_history=true`. The release uses a plain fast-forward push and **aborts loudly** if `main` advanced.
- **SHA-pin every third-party AND first-party action** to a full commit SHA (not `@v2`) — actions run while the App token is in scope.
- **Codesign:** ad-hoc only (`codesign --sign - --force`) on macOS slices. No Developer-ID notarization.
- **License:** the repo is GPLv3 → formula `license "GPL-3.0-or-later"` (confirm against `LICENSE` "or any later version" wording; use `GPL-3.0-only` if absent).
- **`ACTIONS_STEP_DEBUG` must not be enabled** on the release workflow (token hygiene).
- **Two repos:** `Twinning-Labs/styre` (this repo) and `Twinning-Labs/homebrew-styre` (created in Task 6).

---

## File Structure

In `Twinning-Labs/styre`:
- `scripts/artifact-name.ts` — **create.** Single source for tarball/checksum filenames. Pure `artifactName()` + CLI shim.
- `scripts/stamp-version.ts` — **create.** Write a given version into `package.json` (working-tree stamp). Pure `stampVersion()` + CLI shim.
- `scripts/render-formula.ts` — **create.** Render `Formula/styre.rb` from version + 4×{os,arch,sha256}. Pure `renderFormula()` + CLI shim. Owns the formula template.
- `scripts/build.sh` — **modify.** Parameterize `TARGET` + `OUTFILE`; keep the Darwin ad-hoc codesign branch.
- `cliff.toml` — **create.** git-cliff config: conventional parsers, `chore(release)` skip, `breaking_always_bump_major`, changelog template.
- `.github/workflows/ci.yml` — **modify.** Add a PR-title Conventional-Commits lint job.
- `.github/workflows/release.yml` — **create.** The release engine (compute → build → publish).
- `test/release/artifact-name.test.ts`, `test/release/stamp-version.test.ts`, `test/release/render-formula.test.ts` — **create.**

In `Twinning-Labs/homebrew-styre` (new repo, Task 6):
- `Formula/styre.rb` — placeholder (non-installable), later overwritten by the release.
- `README.md` — minimal tap readme.

Repo settings (not files): squash default commit message; App secrets; (branch protection already done).

---

## Task 1: Artifact-naming single source

**Files:**
- Create: `scripts/artifact-name.ts`
- Test: `test/release/artifact-name.test.ts`

**Interfaces:**
- Produces: `artifactName(version: string, os: "darwin" | "linux", arch: "arm64" | "x64"): string` returning `styre-v<version>-<os>-<arch>.tar.gz`. CLI: `bun run scripts/artifact-name.ts <version> <os> <arch>` prints the name (no trailing newline beyond one). Consumed by Task 4 (formula urls) and Task 7/8 (build tarball naming).

- [ ] **Step 1: Write the failing test**

```ts
// test/release/artifact-name.test.ts
import { expect, test } from "bun:test";
import { artifactName } from "../../scripts/artifact-name.ts";

test("artifactName builds the canonical tarball name", () => {
  expect(artifactName("0.1.0", "darwin", "arm64")).toBe("styre-v0.1.0-darwin-arm64.tar.gz");
  expect(artifactName("1.2.3", "linux", "x64")).toBe("styre-v1.2.3-linux-x64.tar.gz");
});

test("artifactName strips a leading v if the caller passes one", () => {
  expect(artifactName("v0.1.0", "linux", "arm64")).toBe("styre-v0.1.0-linux-arm64.tar.gz");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/release/artifact-name.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/artifact-name.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/artifact-name.ts
export function artifactName(
  version: string,
  os: "darwin" | "linux",
  arch: "arm64" | "x64",
): string {
  const v = version.replace(/^v/, "");
  return `styre-v${v}-${os}-${arch}.tar.gz`;
}

if (import.meta.main) {
  const [version, os, arch] = process.argv.slice(2);
  if (!version || !os || !arch) {
    process.stderr.write("usage: artifact-name.ts <version> <darwin|linux> <arm64|x64>\n");
    process.exit(2);
  }
  process.stdout.write(artifactName(version, os as "darwin" | "linux", arch as "arm64" | "x64"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/release/artifact-name.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add scripts/artifact-name.ts test/release/artifact-name.test.ts
git commit -m "feat(release): artifact-name single source for tarball filenames"
```

---

## Task 2: Version stamping

**Files:**
- Create: `scripts/stamp-version.ts`
- Test: `test/release/stamp-version.test.ts`

**Interfaces:**
- Produces: `stampVersion(pkgJson: string, version: string): string` — returns the `package.json` text with `"version"` set to the bare version (no leading `v`), preserving 2-space indentation and trailing newline. CLI: `bun run scripts/stamp-version.ts <version> [path=package.json]` writes the file in place. Consumed by the publish job (Task 9) before the build/commit.

- [ ] **Step 1: Write the failing test**

```ts
// test/release/stamp-version.test.ts
import { expect, test } from "bun:test";
import { stampVersion } from "../../scripts/stamp-version.ts";

const SAMPLE = `{\n  "name": "styre",\n  "version": "0.0.0",\n  "type": "module"\n}\n`;

test("stampVersion replaces the version and keeps formatting", () => {
  const out = stampVersion(SAMPLE, "0.1.0");
  expect(out).toContain(`"version": "0.1.0"`);
  expect(out).not.toContain(`"0.0.0"`);
  expect(out.endsWith("}\n")).toBe(true);
});

test("stampVersion strips a leading v", () => {
  expect(stampVersion(SAMPLE, "v2.0.0")).toContain(`"version": "2.0.0"`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/release/stamp-version.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/stamp-version.ts
export function stampVersion(pkgJson: string, version: string): string {
  const v = version.replace(/^v/, "");
  // Replace only the top-level "version" field; preserve everything else byte-for-byte.
  return pkgJson.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`);
}

if (import.meta.main) {
  const [version, path = "package.json"] = process.argv.slice(2);
  if (!version) {
    process.stderr.write("usage: stamp-version.ts <version> [path]\n");
    process.exit(2);
  }
  const text = await Bun.file(path).text();
  await Bun.write(path, stampVersion(text, version));
  process.stdout.write(`stamped ${path} -> ${version.replace(/^v/, "")}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/release/stamp-version.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add scripts/stamp-version.ts test/release/stamp-version.test.ts
git commit -m "feat(release): stamp-version script for build-time package.json version"
```

---

## Task 3: Generalize `build.sh` for per-target builds

**Files:**
- Modify: `scripts/build.sh`

**Interfaces:**
- Produces: `build.sh` honoring two env vars — `TARGET` (a Bun `--target`, e.g. `bun-darwin-arm64`; empty = native default) and `OUTFILE` (default `dist/styre`). Native macOS builds are ad-hoc codesigned. Consumed by Task 8's build matrix.

- [ ] **Step 1: Read the current file**

Run: `cat scripts/build.sh`
Expected: the existing 9-line script (`bun build --compile ./src/index.ts --outfile dist/styre` + Darwin codesign).

- [ ] **Step 2: Rewrite `build.sh`**

```sh
#!/usr/bin/env sh
set -e

OUTFILE="${OUTFILE:-dist/styre}"
mkdir -p "$(dirname "$OUTFILE")"

# TARGET is an optional Bun --target (e.g. bun-darwin-arm64). Empty => native.
if [ -n "$TARGET" ]; then
  bun build --compile --target="$TARGET" ./src/index.ts --outfile "$OUTFILE"
else
  bun build --compile ./src/index.ts --outfile "$OUTFILE"
fi

# Bun's compiled binary ships an ad-hoc "linker-signed" signature that newer
# macOS (Apple Silicon) rejects with SIGKILL (exit 137); re-sign ad-hoc so it
# runs. Only on a macOS host (codesign exists); Linux/CI skips this.
if [ "$(uname)" = "Darwin" ]; then
  codesign --sign - --force "$OUTFILE"
fi
```

- [ ] **Step 3: Verify a native build still works and smokes**

Run:
```bash
OUTFILE=dist/styre bun run build && ./dist/styre --version
```
Expected: prints `0.0.0` (current package.json version), exit 0.

- [ ] **Step 4: Verify the OUTFILE override works**

Run:
```bash
OUTFILE=dist/styre-test sh scripts/build.sh && ./dist/styre-test --version && rm -f dist/styre-test
```
Expected: prints `0.0.0`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/build.sh
git commit -m "feat(release): parameterize build.sh with TARGET and OUTFILE"
```

---

## Task 4: Formula renderer

**Files:**
- Create: `scripts/render-formula.ts`
- Test: `test/release/render-formula.test.ts`

**Interfaces:**
- Consumes: `artifactName()` from Task 1.
- Produces: `renderFormula(version: string, shas: { darwinArm64: string; darwinX64: string; linuxArm64: string; linuxX64: string }): string` returning the full `Formula/styre.rb` text. CLI: `bun run scripts/render-formula.ts <version> <darwinArm64Sha> <darwinX64Sha> <linuxArm64Sha> <linuxX64Sha>` prints the formula. Consumed by the publish job (Task 9) tap-bump step. The four `url`s are built from `artifactName()` against `https://github.com/Twinning-Labs/styre/releases/download/v<version>/`.

- [ ] **Step 1: Write the failing test**

```ts
// test/release/render-formula.test.ts
import { expect, test } from "bun:test";
import { renderFormula } from "../../scripts/render-formula.ts";

const SHAS = {
  darwinArm64: "a".repeat(64),
  darwinX64: "b".repeat(64),
  linuxArm64: "c".repeat(64),
  linuxX64: "d".repeat(64),
};

test("renderFormula embeds version, license, and all four url/sha pairs", () => {
  const f = renderFormula("0.1.0", SHAS);
  expect(f).toContain('class Styre < Formula');
  expect(f).toContain('license "GPL-3.0-or-later"');
  expect(f).toContain('version "0.1.0"');
  // urls
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-darwin-arm64.tar.gz");
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-linux-x64.tar.gz");
  // shas, one per slice
  expect(f).toContain(`sha256 "${"a".repeat(64)}"`);
  expect(f).toContain(`sha256 "${"d".repeat(64)}"`);
  // structure
  expect(f).toContain("on_macos do");
  expect(f).toContain("on_linux do");
  expect(f).toContain('bin.install "styre"');
  expect(f).toContain("test do");
});

test("renderFormula rejects a non-64-hex sha", () => {
  expect(() => renderFormula("0.1.0", { ...SHAS, linuxX64: "short" })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/release/render-formula.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/render-formula.ts
import { artifactName } from "./artifact-name.ts";

const BASE = "https://github.com/Twinning-Labs/styre/releases/download";

export interface FormulaShas {
  darwinArm64: string;
  darwinX64: string;
  linuxArm64: string;
  linuxX64: string;
}

function url(version: string, os: "darwin" | "linux", arch: "arm64" | "x64"): string {
  const v = version.replace(/^v/, "");
  return `${BASE}/v${v}/${artifactName(v, os, arch)}`;
}

function assertSha(label: string, sha: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`invalid sha256 for ${label}: ${sha}`);
  }
}

export function renderFormula(version: string, shas: FormulaShas): string {
  const v = version.replace(/^v/, "");
  assertSha("darwin-arm64", shas.darwinArm64);
  assertSha("darwin-x64", shas.darwinX64);
  assertSha("linux-arm64", shas.linuxArm64);
  assertSha("linux-x64", shas.linuxX64);
  return `class Styre < Formula
  desc "Open-source autonomous-SDLC execution core"
  homepage "https://github.com/Twinning-Labs/styre"
  version "${v}"
  license "GPL-3.0-or-later"

  on_macos do
    on_arm do
      url "${url(v, "darwin", "arm64")}"
      sha256 "${shas.darwinArm64}"
    end
    on_intel do
      url "${url(v, "darwin", "x64")}"
      sha256 "${shas.darwinX64}"
    end
  end

  on_linux do
    on_arm do
      url "${url(v, "linux", "arm64")}"
      sha256 "${shas.linuxArm64}"
    end
    on_intel do
      url "${url(v, "linux", "x64")}"
      sha256 "${shas.linuxX64}"
    end
  end

  def install
    bin.install "styre"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/styre --version")
  end
end
`;
}

if (import.meta.main) {
  const [version, da, dx, la, lx] = process.argv.slice(2);
  if (!version || !da || !dx || !la || !lx) {
    process.stderr.write(
      "usage: render-formula.ts <version> <darwinArm64Sha> <darwinX64Sha> <linuxArm64Sha> <linuxX64Sha>\n",
    );
    process.exit(2);
  }
  process.stdout.write(
    renderFormula(version, { darwinArm64: da, darwinX64: dx, linuxArm64: la, linuxX64: lx }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/release/render-formula.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Lint + commit**

```bash
bun run lint
git add scripts/render-formula.ts test/release/render-formula.test.ts
git commit -m "feat(release): formula renderer with four-platform url/sha blocks"
```

---

## Task 5: git-cliff config (`cliff.toml`)

**Files:**
- Create: `cliff.toml`

**Interfaces:**
- Produces: a `cliff.toml` such that `git cliff --bumped-version` prints the next semver and `git cliff --unreleased --tag <vX>` renders the changelog section. `chore(release)` commits are skipped; breaking changes bump major even pre-1.0. Consumed by Tasks 8/9.

- [ ] **Step 1: Install git-cliff locally (for verification)**

Run: `brew install git-cliff` (macOS) — version 2.x.
Expected: `git cliff --version` prints `git-cliff 2.x`.

- [ ] **Step 2: Write `cliff.toml`**

```toml
[changelog]
header = "# Changelog\n\nAll notable changes to this project are documented here.\n"
body = """
{% if version %}\
## [{{ version | trim_start_matches(pat="v") }}] - {{ timestamp | date(format="%Y-%m-%d") }}
{% else %}\
## [Unreleased]
{% endif %}\
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group | upper_first }}
{% for commit in commits %}\
- {{ commit.message | split(pat="\n") | first | upper_first }}\
{% endfor %}
{% endfor %}\n
"""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
split_commits = false
tag_pattern = "v[0-9]*"
commit_parsers = [
  { message = "^chore\\(release\\)", skip = true },
  { message = "^feat", group = "Features" },
  { message = "^fix", group = "Bug Fixes" },
  { message = "^perf", group = "Performance" },
  { message = "^refactor", group = "Refactor" },
  { message = "^docs", group = "Documentation" },
  { message = "^test", group = "Tests" },
  { message = "^ci", group = "CI" },
  { message = "^chore", group = "Chores" },
]
filter_commits = false

[bump]
features_always_bump_minor = true
breaking_always_bump_major = true
```

- [ ] **Step 3: Verify the first computed version is `0.1.0`**

Run: `git cliff --bumped-version`
Expected: `v0.1.0` (no prior tag → first release floor). If it prints something else, the repo already has unexpected tags — stop and investigate.

- [ ] **Step 4: Verify a changelog renders without error**

Run: `git cliff --unreleased -o -`
Expected: a Markdown `## [Unreleased]` section grouping the existing conventional commits; no template error.

- [ ] **Step 5: Verify `breaking_always_bump_major` is honored**

Run:
```bash
git cliff --bumped-version --with-commit "feat!: trigger major" 2>/dev/null || \
  echo "NOTE: verify in dry_run (Task 8) if --with-commit unsupported in this git-cliff version"
```
Expected: `v1.0.0` (a breaking change bumps major even from `0.x`). If the local git-cliff version doesn't support `--with-commit`, this is conclusively verified by the Task 8 dry-run instead.

- [ ] **Step 6: Commit**

```bash
git add cliff.toml
git commit -m "feat(release): git-cliff config (pre-1.0 major bump, chore(release) skip)"
```

---

## Task 6: PR-title lint + squash settings + tap repo

**Files:**
- Modify: `.github/workflows/ci.yml`

This task bundles the PR-pipeline guardrails (PR-title lint + squash default message) and the tap repo, since both must exist before the release workflow is meaningful and neither carries its own code test cycle.

- [ ] **Step 1: Resolve pinned SHAs for the actions used here**

Run:
```bash
gh api repos/amannn/action-semantic-pull-request/commits/v5 --jq '.sha'
gh api repos/actions/checkout/commits/v4 --jq '.sha'
```
Expected: two 40-char SHAs. Record them as `SEMANTIC_PR_SHA` and `CHECKOUT_SHA` for the next step.

- [ ] **Step 2: Add the PR-title lint job to `ci.yml`**

Append this job under `jobs:` (alongside the existing `check` job), substituting the SHA from Step 1:

```yaml
  pr-title:
    # Conventional-Commits lint on the PR title. Squash-merge makes the PR title
    # the commit + changelog line git-cliff parses, so a malformed title would
    # silently corrupt version/changelog computation.
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: read
    steps:
      - uses: amannn/action-semantic-pull-request@<SEMANTIC_PR_SHA>  # v5.x
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Validate the workflow syntax**

Run: `brew install actionlint >/dev/null 2>&1; actionlint .github/workflows/ci.yml`
Expected: no output (valid). If actionlint flags the `<SEMANTIC_PR_SHA>` placeholder, confirm you substituted the real SHA.

- [ ] **Step 4: Set the squash default commit message (manual repo setting)**

In `github.com/Twinning-Labs/styre` → Settings → General → "Pull Requests": set **"Default commit message" = "Pull request title and description"**. Verify:
```bash
gh api repos/Twinning-Labs/styre --jq '{merge: .squash_merge_commit_title, body: .squash_merge_commit_message}'
```
Expected: `merge: "PR_TITLE"`, `body: "PR_BODY"`.

- [ ] **Step 5: Create the tap repo with a non-installable placeholder formula**

```bash
TMP=$(mktemp -d)
git -C "$TMP" init -q
mkdir -p "$TMP/Formula"
cat > "$TMP/Formula/styre.rb" <<'RB'
class Styre < Formula
  desc "Open-source autonomous-SDLC execution core"
  homepage "https://github.com/Twinning-Labs/styre"
  version "0.0.0"
  license "GPL-3.0-or-later"

  # Placeholder: no release has been published yet. The first styre release
  # populates real urls + sha256 for all four platforms (darwin/linux × arm64/x64).
  def install
    odie "styre has no published release yet — see https://github.com/Twinning-Labs/styre"
  end
end
RB
printf '# homebrew-styre\n\nHomebrew tap for [styre](https://github.com/Twinning-Labs/styre).\n\n```\nbrew install twinning-labs/styre\n```\n' > "$TMP/README.md"
git -C "$TMP" add -A
git -C "$TMP" commit -q -m "chore: bootstrap tap with placeholder formula"
gh repo create Twinning-Labs/homebrew-styre --public --source "$TMP" --remote origin --push
```
Expected: repo created and pushed.

- [ ] **Step 6: Confirm the App is installed on the tap repo**

Run: `gh api repos/Twinning-Labs/homebrew-styre --jq '.full_name'`
Expected: `Twinning-Labs/homebrew-styre`. (The `styre-release-bot` App install on this repo was done per the ticket; if a later token-mint in Task 9 fails with "not installed", install the App on `homebrew-styre` via the App settings page.)

- [ ] **Step 7: Commit the CI change**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: enforce Conventional Commits on PR titles"
```

---

## Task 7: Release workflow — compute + build + dry-run (no publish)

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/build.sh` (Task 3), `scripts/artifact-name.ts` (Task 1), `cliff.toml` (Task 5).
- Produces: a `workflow_dispatch` workflow with the `compute` and `build` jobs and a `dry_run` input. `compute` outputs `version`, `sha0`, and `should_release`. `build` is the 4-job matrix uploading `<artifactName>.tar.gz` + `.sha256` per slice. The publish job is added in Task 8.

- [ ] **Step 1: Resolve pinned SHAs for the release actions**

Run:
```bash
gh api repos/actions/checkout/commits/v4 --jq '.sha'
gh api repos/oven-sh/setup-bun/commits/v2 --jq '.sha'
gh api repos/actions/upload-artifact/commits/v4 --jq '.sha'
gh api repos/orhun/git-cliff-action/commits/v4 --jq '.sha'
```
Record as `CHECKOUT_SHA`, `SETUP_BUN_SHA`, `UPLOAD_SHA`, `CLIFF_SHA`. Substitute below.

- [ ] **Step 2: Write `release.yml` (compute + build jobs)**

```yaml
name: Release
on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Compute + build + checksum only; publish nothing, commit nothing."
        type: boolean
        default: true
      expected_sha:
        description: "Optional: abort if main HEAD != this SHA (bind a previewed dry-run)."
        type: string
        default: ""
      expected_version:
        description: "Optional: abort if the computed version != this (e.g. v0.1.0)."
        type: string
        default: ""

concurrency:
  group: release
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  compute:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.cliff.outputs.version }}
      sha0: ${{ steps.pin.outputs.sha0 }}
      should_release: ${{ steps.guard.outputs.should_release }}
    steps:
      - uses: actions/checkout@<CHECKOUT_SHA>  # v4
        with:
          fetch-depth: 0  # full history + tags for git-cliff
      - id: pin
        run: echo "sha0=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - name: Abort if main moved since the previewed dispatch
        if: inputs.expected_sha != ''
        run: |
          if [ "$(git rev-parse HEAD)" != "${{ inputs.expected_sha }}" ]; then
            echo "::error::main HEAD $(git rev-parse HEAD) != expected_sha ${{ inputs.expected_sha }}"; exit 1
          fi
      - id: cliff
        uses: orhun/git-cliff-action@<CLIFF_SHA>  # v4
        with:
          args: --bumped-version
      - name: Abort if computed version != expected_version
        if: inputs.expected_version != ''
        run: |
          if [ "${{ steps.cliff.outputs.version }}" != "${{ inputs.expected_version }}" ]; then
            echo "::error::computed ${{ steps.cliff.outputs.version }} != expected ${{ inputs.expected_version }}"; exit 1
          fi
      - id: guard
        env:
          GH_TOKEN: ${{ github.token }}
          V: ${{ steps.cliff.outputs.version }}
        run: |
          # Per-effect idempotency starts here: if the tag already exists, a real
          # run still proceeds to the publish job, which probes each effect. But
          # if there is nothing to release, stop.
          if [ -z "$V" ] || [ "$V" = "null" ]; then
            echo "should_release=false" >> "$GITHUB_OUTPUT"
            echo "::notice::nothing to release since last tag"; exit 0
          fi
          echo "should_release=true" >> "$GITHUB_OUTPUT"
          echo "::notice::next version = $V"
      - name: Dry-run preview (version + changelog + bump drivers)
        if: inputs.dry_run
        uses: orhun/git-cliff-action@<CLIFF_SHA>  # v4
        with:
          args: --unreleased --tag ${{ steps.cliff.outputs.version }} -o -

  build:
    needs: compute
    if: needs.compute.outputs.should_release == 'true'
    strategy:
      fail-fast: true
      matrix:
        include:
          - runner: macos-14
            os: darwin
            arch: arm64
            target: bun-darwin-arm64
          - runner: macos-13
            os: darwin
            arch: x64
            target: bun-darwin-x64
          - runner: ubuntu-latest
            os: linux
            arch: x64
            target: bun-linux-x64
          - runner: ubuntu-24.04-arm
            os: linux
            arch: arm64
            target: bun-linux-arm64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@<CHECKOUT_SHA>  # v4
        with:
          ref: ${{ needs.compute.outputs.sha0 }}
      - uses: oven-sh/setup-bun@<SETUP_BUN_SHA>  # v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Stamp version (build-time, working tree only)
        run: bun run scripts/stamp-version.ts "${{ needs.compute.outputs.version }}"
      - name: Build native slice
        env:
          TARGET: ${{ matrix.target }}
          OUTFILE: dist/styre
        run: bun run scripts/build.sh
      - name: Smoke on real arch
        run: |
          GOT="$(./dist/styre --version)"
          WANT="${{ needs.compute.outputs.version }}"; WANT="${WANT#v}"
          test "$GOT" = "$WANT" || { echo "::error::version $GOT != $WANT"; exit 1; }
      - name: Tarball + sha256
        run: |
          NAME="$(bun run scripts/artifact-name.ts "${{ needs.compute.outputs.version }}" "${{ matrix.os }}" "${{ matrix.arch }}")"
          tar -C dist -czf "$NAME" styre
          shasum -a 256 "$NAME" | awk '{print $1}' > "$NAME.sha256"
          echo "ARTIFACT=$NAME" >> "$GITHUB_ENV"
      - uses: actions/upload-artifact@<UPLOAD_SHA>  # v4
        with:
          name: styre-${{ matrix.os }}-${{ matrix.arch }}
          path: |
            ${{ env.ARTIFACT }}
            ${{ env.ARTIFACT }}.sha256
          if-no-files-found: error
          retention-days: 7
```

- [ ] **Step 3: Validate workflow syntax**

Run: `actionlint .github/workflows/release.yml`
Expected: no output. Fix any unsubstituted `<...SHA>` placeholders it flags.

- [ ] **Step 4: Commit, push the branch, and run a dry-run end-to-end**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): release.yml compute + native build matrix (dry-run capable)"
git push
gh workflow run release.yml --ref "$(git rev-parse --abbrev-ref HEAD)" -f dry_run=true
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: `compute` prints `next version = v0.1.0` and a changelog preview; all 4 `build` jobs succeed and upload artifacts; **nothing is committed, tagged, or published.** Download an artifact and confirm:
```bash
gh run download "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" -n styre-linux-x64
ls styre-v0.1.0-linux-x64.tar.gz styre-v0.1.0-linux-x64.tar.gz.sha256
```
Expected: both files present.

- [ ] **Step 5: Confirm no side effects**

```bash
git ls-remote --tags origin | grep v0.1.0 || echo "no tag (correct)"
gh release list -R Twinning-Labs/styre | grep v0.1.0 || echo "no release (correct)"
```
Expected: both print the "correct" line.

---

## Task 8: Release workflow — publish gate (FF commit + tag + Release + tap), per-effect idempotent

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `compute` outputs (`version`, `sha0`), the 4 `build` artifacts, `scripts/stamp-version.ts`, `scripts/render-formula.ts`, `cliff.toml`. Requires secrets `STYRE_RELEASE_APP_ID`, `STYRE_RELEASE_APP_PRIVATE_KEY`.
- Produces: a `publish` job gated on all 4 builds, skipped when `dry_run`, performing FF commit + tag + Release + tap bump with probe-then-apply on each.

- [ ] **Step 1: Confirm the App secrets exist**

Run: `gh secret list -R Twinning-Labs/styre | grep -E 'STYRE_RELEASE_APP_ID|STYRE_RELEASE_APP_PRIVATE_KEY'`
Expected: both listed. If missing, add them (App id and the App's PEM private key) before proceeding.

- [ ] **Step 2: Resolve the App-token action SHA + download-artifact SHA**

Run:
```bash
gh api repos/actions/create-github-app-token/commits/v2 --jq '.sha'
gh api repos/actions/download-artifact/commits/v4 --jq '.sha'
```
Record as `APP_TOKEN_SHA`, `DOWNLOAD_SHA`.

- [ ] **Step 3: Add the `publish` job to `release.yml`**

Append under `jobs:` (after `build`), substituting SHAs:

```yaml
  publish:
    needs: [compute, build]
    if: ${{ !inputs.dry_run && needs.compute.outputs.should_release == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - name: Mint styre-scoped App token (commit + tag + release)
        id: styre_token
        uses: actions/create-github-app-token@<APP_TOKEN_SHA>  # v2
        with:
          app-id: ${{ secrets.STYRE_RELEASE_APP_ID }}
          private-key: ${{ secrets.STYRE_RELEASE_APP_PRIVATE_KEY }}
          owner: Twinning-Labs
          repositories: styre
      - uses: actions/checkout@<CHECKOUT_SHA>  # v4
        with:
          ref: ${{ needs.compute.outputs.sha0 }}
          fetch-depth: 0
          token: ${{ steps.styre_token.outputs.token }}
      - uses: oven-sh/setup-bun@<SETUP_BUN_SHA>  # v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Download all build artifacts
        uses: actions/download-artifact@<DOWNLOAD_SHA>  # v4
        with:
          path: artifacts
          merge-multiple: true
      - name: Render changelog file
        uses: orhun/git-cliff-action@<CLIFF_SHA>  # v4
        with:
          args: --tag ${{ needs.compute.outputs.version }} -o CHANGELOG.md
      - name: Stamp version + commit (FF push, abort if main moved)
        id: commit
        env:
          V: ${{ needs.compute.outputs.version }}
        run: |
          set -e
          bun run scripts/stamp-version.ts "$V"
          git config user.name "styre-release-bot[bot]"
          git config user.email "styre-release-bot[bot]@users.noreply.github.com"
          git add package.json CHANGELOG.md
          git commit -m "chore(release): $V"
          # Fast-forward push only. If main advanced since sha0, this is NOT a
          # fast-forward and the push is rejected -> abort, nothing published.
          git push origin "HEAD:main"
          echo "release_sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - name: Tag (probe-then-apply)
        env:
          V: ${{ needs.compute.outputs.version }}
        run: |
          if git ls-remote --tags origin "refs/tags/$V" | grep -q "$V"; then
            echo "::notice::tag $V already exists, skipping"
          else
            git tag "$V" "${{ steps.commit.outputs.release_sha }}"
            git push origin "$V"
          fi
      - name: Create/repair GitHub Release (probe-then-apply assets)
        env:
          GH_TOKEN: ${{ steps.styre_token.outputs.token }}
          V: ${{ needs.compute.outputs.version }}
        run: |
          set -e
          if ! gh release view "$V" -R Twinning-Labs/styre >/dev/null 2>&1; then
            gh release create "$V" -R Twinning-Labs/styre \
              --title "$V" --notes-file CHANGELOG.md --verify-tag
          fi
          # Upload any of the 8 files (4 tarballs + 4 sha256) not already attached.
          existing="$(gh release view "$V" -R Twinning-Labs/styre --json assets --jq '.assets[].name')"
          for f in artifacts/styre-*.tar.gz artifacts/styre-*.tar.gz.sha256; do
            base="$(basename "$f")"
            if echo "$existing" | grep -qx "$base"; then
              echo "asset $base present"
            else
              gh release upload "$V" -R Twinning-Labs/styre "$f"
            fi
          done
      - name: Mint tap-scoped App token
        id: tap_token
        uses: actions/create-github-app-token@<APP_TOKEN_SHA>  # v2
        with:
          app-id: ${{ secrets.STYRE_RELEASE_APP_ID }}
          private-key: ${{ secrets.STYRE_RELEASE_APP_PRIVATE_KEY }}
          owner: Twinning-Labs
          repositories: homebrew-styre
      - name: Bump tap formula (probe-then-apply)
        env:
          V: ${{ needs.compute.outputs.version }}
          TAP_TOKEN: ${{ steps.tap_token.outputs.token }}
        run: |
          set -e
          v="${V#v}"
          read_sha() { cat "artifacts/styre-v${v}-$1.tar.gz.sha256"; }
          DA="$(read_sha darwin-arm64)"; DX="$(read_sha darwin-x64)"
          LA="$(read_sha linux-arm64)";  LX="$(read_sha linux-x64)"
          bun run scripts/render-formula.ts "$v" "$DA" "$DX" "$LA" "$LX" > /tmp/styre.rb
          git clone "https://x-access-token:${TAP_TOKEN}@github.com/Twinning-Labs/homebrew-styre.git" /tmp/tap
          if cmp -s /tmp/styre.rb /tmp/tap/Formula/styre.rb; then
            echo "::notice::tap already at this build, skipping"
          else
            cp /tmp/styre.rb /tmp/tap/Formula/styre.rb
            git -C /tmp/tap config user.name "styre-release-bot[bot]"
            git -C /tmp/tap config user.email "styre-release-bot[bot]@users.noreply.github.com"
            git -C /tmp/tap commit -am "styre $V"
            git -C /tmp/tap push origin HEAD
          fi
```

- [ ] **Step 4: Validate syntax**

Run: `actionlint .github/workflows/release.yml`
Expected: no output.

- [ ] **Step 5: Commit + push**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): publish gate — FF commit, tag, Release, tap bump (per-effect idempotent)"
git push
```

- [ ] **Step 6: Re-run the dry-run to confirm publish is correctly skipped**

```bash
gh workflow run release.yml --ref "$(git rev-parse --abbrev-ref HEAD)" -f dry_run=true
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: `compute` + `build` run; `publish` shows as skipped.

> **Note — the first real release happens after this branch merges to `main`** (so `release.yml` and `cliff.toml` exist on `main` and the FF commit targets `main`). It is operator-triggered: `gh workflow run release.yml -f dry_run=false`. That is verified in Task 9, not here.

---

## Task 9: First real release + post-release brew smoke

**Files:**
- Modify: `.github/workflows/release.yml` (add the `smoke` job)

**Interfaces:**
- Consumes: the published Release + bumped tap from the `publish` job.
- Produces: a `smoke` job that `brew install`s on all four targets and runs `brew audit --strict`.

- [ ] **Step 1: Add the `smoke` job to `release.yml`**

Append under `jobs:`, substituting `CHECKOUT_SHA`:

```yaml
  smoke:
    needs: publish
    if: ${{ !inputs.dry_run }}
    strategy:
      fail-fast: false
      matrix:
        runner: [macos-14, macos-13, ubuntu-latest, ubuntu-24.04-arm]
    runs-on: ${{ matrix.runner }}
    steps:
      - name: brew install from the tap + smoke
        run: |
          brew tap twinning-labs/styre
          brew install twinning-labs/styre/styre
          styre --version
      - name: brew audit (strict)
        run: brew audit --strict --online twinning-labs/styre/styre
```

- [ ] **Step 2: Validate + commit + push**

```bash
actionlint .github/workflows/release.yml
git add .github/workflows/release.yml
git commit -m "feat(release): post-release brew install smoke + audit on all four targets"
git push
```

- [ ] **Step 3: (Operator, after the PR merges to `main`) trigger the first real release**

```bash
# Preview first:
gh workflow run release.yml --ref main -f dry_run=true
# then, if v0.1.0 + changelog look right, bind the preview and release:
gh workflow run release.yml --ref main -f dry_run=false -f expected_version=v0.1.0
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: a `v0.1.0` GitHub Release with 4 tarballs + 4 `.sha256`; `CHANGELOG.md` + version bump committed to `main` as `styre-release-bot[bot]`; the tap formula bumped; the `smoke` matrix green.

- [ ] **Step 4: Verify the end-user install path**

```bash
gh release view v0.1.0 -R Twinning-Labs/styre --json assets --jq '.assets[].name'   # expect 8 names
brew untap twinning-labs/styre 2>/dev/null; brew install twinning-labs/styre
styre --version   # expect 0.1.0
```
Expected: `styre --version` prints `0.1.0`.

- [ ] **Step 5: Verify idempotent re-run heals, not cements**

```bash
# Re-dispatch the same version; nothing should change, no errors.
gh workflow run release.yml --ref main -f dry_run=false -f expected_version=v0.1.0
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: publish job runs but every probe reports "already present / already at this build"; no duplicate assets, no duplicate tag, tap unchanged.

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Settled pillars: workflow_dispatch-only + dry_run (Task 7), git-cliff single engine (Tasks 5/7/8), App token no-PAT (Task 8), dedicated tap (Task 6), ad-hoc codesign (Task 3). ✓
- D1 native-per-arch matrix → Task 7. ✓
- D2 versioning (v0.1.0, breaking→major non-default) → Task 5 (`cliff.toml`) + Global Constraints. ✓
- D3 FF changelog push → Task 8 commit step. ✓
- D4 FF-only bypass → Global Constraints + already-configured; the FF push relies on it (Task 8). ✓
- D5 immutable SHA pin → `compute.sha0` threaded into `build`/`publish` (Tasks 7/8). ✓
- Release flow ordering + dry_run binding → Tasks 7/8. ✓
- Recovery / per-effect idempotency → Task 8 probe-then-apply steps + Task 9 Step 5. ✓
- cliff.toml (pre-1.0 config, chore(release) skip, baseline) → Task 5. ✓
- build.sh generalized → Task 3. ✓
- ci.yml PR-title lint → Task 6. ✓
- tap repo + placeholder bootstrap → Task 6. ✓
- artifact naming single source → Task 1. ✓
- brew audit stanzas (license/desc/homepage/version) → Task 4 renderer. ✓
- post-release 4-target smoke → Task 9. ✓
- SHA-pin actions → Steps in Tasks 6/7/8 resolve+pin. ✓
- token's 3 ops + mint in publish job → Task 8. ✓
- repo settings (squash default message, secrets) → Tasks 6/8. ✓

**2. Placeholder scan:** Action SHAs are intentionally resolved-and-substituted via explicit `gh api` commands (not hand-waved). No "TBD"/"add error handling"/"write tests for the above" — every code step shows real code. ✓

**3. Type consistency:** `artifactName(version,os,arch)` used identically in Tasks 1, 4, 7. `renderFormula(version, {darwinArm64,darwinX64,linuxArm64,linuxX64})` keys match between Task 4 definition and Task 8 invocation order (DA,DX,LA,LX). `compute` outputs `version`/`sha0`/`should_release` consumed consistently in `build`/`publish`. ✓

## Known sequencing notes (not gaps)

- **git-cliff baseline:** with no prior tag the first run parses all history (pre-lint commits). `v0.1.0` is the hardcoded floor, so version is safe; the first changelog is best-effort over historical commits. Acceptable for the first release (spec "Open follow-ups").
- **Real-release ordering:** Tasks 7–8 are verifiable on the feature branch via `--ref <branch>` dry-runs; the first non-dry release (Task 9 Step 3) must run from `main` after merge so the FF commit targets `main`. This is called out in each task.
