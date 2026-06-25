# Documentation Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the outward-facing documentation layer Styre is missing (a real README front door, an architecture index over the existing frozen spec, two concept docs, and the standard OSS community-health files) without touching the already-best-in-class internal design docs.

**Architecture:** Styre's *internal* design exposure (`docs/architecture/` frozen spec + the ADR-shaped decision register in `brainstorm.md` §10) already exceeds every OSS project surveyed; the gap is that 100% of it is contributor/internals-facing and there is no front door. This plan adds three tiers: **Tier 1** front door (README rewrite, animated cast, `SECURITY.md` / `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md`, `.github/` templates); **Tier 2** a navigation layer over existing depth (`docs/architecture/README.md` index, an execution-model concept doc, a glossary). A docs site is **explicitly deferred** (Tier 3) — README + in-repo markdown is the right surface until breadth justifies a generator.

**Tech Stack:** Markdown only. No build-system changes except one optional `scripts/` entry + dev-dependency for the animated cast (Task 9). Verification uses `git`, `grep`, and existing `bun`/`biome` where applicable.

## Global Constraints

These apply to **every** task. Copy verbatim where quoted.

- **License is GPLv3.** State it plainly; never imply a crippled core. Repo is `github.com/Twinning-Labs/styre`.
- **OSS surface = three subcommands only: `migrate`, `run`, `setup`.** There is **no `daemon` subcommand in the OSS binary** — the daemon, inbox, scheduling, and continuous pickup are commercial-plane features. Never document a `styre daemon` command as an OSS capability. (Verified against `src/index.ts` `subCommands`.)
- **OSS terminal state is "PR-ready."** Frame the commercial Control Plane as the *layer above* (self-host vs. we-host-it), never as a paywall on the core.
- **Telemetry does not phone home.** `styre run` emits NDJSON telemetry to **stdout** (one JSON object per line); the human-readable summary goes to **stderr**. Library callers default to `noopSink` (emit nothing). There is **no network egress and no remote collection** by the OSS core. (Verified against `src/telemetry/emit.ts` and `src/cli/run.ts`.) Do not describe a Next.js-style "anonymous collection + opt-out" — there is nothing to opt out of.
- **Clean-break stage vocabulary only:** `ticket.stage ∈ {design, implement, verify, review, merge, released}`. **Never** use the legacy gerund stages (`brainstorming`, `planning`, `implementing`, `reviewing`, `building`, `releasing`) or a hardcoded `ui`/`UI` stage. UI is a frontend work-unit + a visual verify check-type.
- **No-auto-merge is a load-bearing rule, not a footnote.** Any contributor/workflow doc states: never commit to `main`; `feat/` and `fix/` branches; PR-only; **the operator merges every PR personally — no `gh pr merge`, no `--auto`.**
- **Lead the trust story with capability isolation:** agents get no `gh`/Linear tools and no ambient `LINEAR_API_KEY`; the worktree is the only writable surface; the daemon holds creds and does the commits.
- **Plan/doc save conventions (CLAUDE.md override):** durable design docs → `docs/design/`; this plan lives in `docs/plans/`. Do **not** write under `docs/superpowers/` or `docs/specs/` (a `PreToolUse` hook hard-blocks it). The existing authoritative design docs remain under `docs/architecture/` for now.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Architecture index — `docs/architecture/README.md`

A Temporal-style index that frames and links the existing frozen docs, written in matklad's ARCHITECTURE.md register: name the components, do **not** deep-link every file (names stay greppable), and state the load-bearing invariants **as absences**. This is the navigation layer over Styre's biggest differentiator.

**Files:**
- Create: `docs/architecture/README.md`

**Interfaces:**
- Consumes: the existing files `minimal-loop.md`, `control-loop.md`, `projector.md`, `schema.sql`, `brainstorm.md`, `build-operations.md` (all in `docs/architecture/`).
- Produces: a stable anchor `docs/architecture/README.md` that Task 4 (README) and Tasks 2–3 link to.

- [ ] **Step 1: Verify the files to be indexed all exist**

Run:
```bash
ls docs/architecture/{minimal-loop,control-loop,projector,brainstorm,build-operations}.md docs/architecture/schema.sql
```
Expected: all six paths listed, no "No such file".

- [ ] **Step 2: Write `docs/architecture/README.md`**

Content requirements (produce the actual prose — no placeholders):
- **Title + one-paragraph framing:** what the substrate is and that these docs are the contributor's map, read top-to-bottom.
- **Reading order** section, mirroring CLAUDE.md, with a one-line "what you get" per doc:
  1. `minimal-loop.md` — the concrete `next_step_key` state machine, loopback resets, budget numbers, the needs-you inbox.
  2. `control-loop.md` — durable control-loop semantics: daemon, event loop, step catalog S1–S10, structured-output interface (§3a), Loopback Atlas (§8), step-author invariants (§9).
  3. `projector.md` — the one-way projector: the sole outward write path from SQLite to Linear/GitHub.
  4. `schema.sql` — the SQLite SoT (16 tables); Memory/UGL is a deferred stub.
  5. `brainstorm.md` — the decision log; note §10 Open Decisions Register is the ADR-style DECIDED/OPEN/SUPERSEDED status of every design item, and that it is append-only.
- **"Invariants (stated as absences)"** section — the load-bearing NOTs, each one line:
  - There is exactly one writer: only the daemon writes SQLite. Workers/agents return results; they never persist.
  - Linear and GitHub are **never read for control flow** — they are one-way projections; inbound facts arrive only as signals.
  - A succeeded `workflow_step` is **never re-run** — the resolver returns its recorded result on replay (exactly-once).
  - Verdicts are **never** agent self-scores — they come from build/tests/CI/scope-diff/independent review (ground truth).
  - There is **no** hardcoded `ui` stage and **no** legacy gerund stage vocabulary.
  - Agents have **no** `gh`/Linear tools and **no** ambient `LINEAR_API_KEY`; the worktree is the only writable surface.
  - The daemon's default response to anomaly is **not** halt-to-human — it is loop (bounded retry against ground truth); human gates are MERGE + escalations only.
- **Codemap pointer:** one line saying the canonical code-layout decisions live in `build-operations.md`; name `src/` top-level dirs (`engine`, `daemon`, `dispatch`, `db`, `integrations`, `agent`, `telemetry`, `setup`, `cli`) without linking them.
- Keep it under ~120 lines; this doc is meant to change slowly.

- [ ] **Step 3: Verify no legacy vocabulary leaked in**

Run:
```bash
grep -niE '\b(brainstorming|implementing|reviewing|releasing)\b|hardcoded ui stage|\bui stage\b' docs/architecture/README.md
```
Expected: no output (exit non-zero is fine). If any line matches, rewrite it using the clean-break vocab.

- [ ] **Step 4: Verify every referenced doc path resolves**

Run:
```bash
for f in $(grep -oE '[a-z0-9./-]+\.(md|sql)' docs/architecture/README.md | sort -u); do
  [ -e "docs/architecture/$f" ] || [ -e "$f" ] || echo "BROKEN: $f"; done
```
Expected: no `BROKEN:` lines.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/README.md
git commit -m "docs: add architecture index over the frozen substrate spec

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Glossary — `docs/architecture/glossary.md`

A flat, austere reference (Diátaxis "reference" quadrant) for the dense vocabulary, so a newcomer can decode the other docs.

**Files:**
- Create: `docs/architecture/glossary.md`

**Interfaces:**
- Consumes: terminology defined across the existing architecture docs.
- Produces: `docs/architecture/glossary.md`, linked from Task 1's index and Task 3's concept doc.

- [ ] **Step 1: Write the glossary**

A single alphabetised definition list. Each entry is one or two sentences, no marketing. Required terms (define every one; pull the precise meaning from the named source doc, do not invent):
- **stage** — the six clean-break values; the ticket's position in the lifecycle.
- **work_unit** — a per-`kind` (backend/frontend/data/…) decomposition of the implement stage; how one stage fans into multiple dispatches.
- **signal** — an inbound ground-truth fact (CI green, merged, human action) delivered to the loop; the *only* inbound channel (control-loop §7).
- **projector** — the one-way drain of `projection_outbox` to Linear/GitHub; the sole outward write path.
- **projection_outbox** — the table written in the *same transaction* as a state change, later drained by the projector.
- **next_step_key** — the routing key the minimal loop computes to pick the next step.
- **loopback** — a reset that sends a ticket back to an earlier stage on a failed gate; see the Loopback Atlas (control-loop §8).
- **needs-you inbox** — the queue of items requiring a human (resume / after-fix / abandon).
- **SoT (Source of Truth)** — the single transactional SQLite database; only the daemon writes it.
- **ground truth** — verdicts from build/tests/CI/scope-diff/independent review, as opposed to agent self-report.
- **workflow_step** — a durable journal entry; a succeeded step returns its recorded result on replay.
- **idempotency key** — the token carried by every external effect so re-application is safe after a crash.
- **K (concurrency cap)** — the limit on concurrent in-flight work (K=2).
- **the projector contract / open-core seam** — the versioned interfaces the commercial plane integrates through (the Linear ticket contract, the project-profile artifact, the telemetry/state export).

- [ ] **Step 2: Verify clean-break vocab**

Run:
```bash
grep -niE '\b(brainstorming|implementing|reviewing|releasing)\b|\bui stage\b' docs/architecture/glossary.md
```
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/glossary.md
git commit -m "docs: add architecture glossary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Concept doc — `docs/architecture/execution-model.md`

The Diátaxis "explanation" page: *how a ticket is actually executed* end to end, in prose a contributor reads away from the code. This is the missing "why/how it hangs together" that the frozen specs assume.

**Files:**
- Create: `docs/architecture/execution-model.md`

**Interfaces:**
- Consumes: `minimal-loop.md`, `control-loop.md`, `projector.md`, plus the glossary (Task 2) for term links.
- Produces: `docs/architecture/execution-model.md`, linked from Task 1's index and Task 4's README.

- [ ] **Step 1: Write the concept doc**

Required content, in order (actual prose, with one small ASCII diagram):
- **The shape of a run:** a ticket enters at `design` and the loop drives it `design → implement → verify → review → merge → released`. Include a compact ASCII diagram of those six stages with loopback arrows.
- **The loop, not a pipeline:** the daemon computes `next_step_key` from persisted state each tick; it is deterministic routing, not a hardcoded sequence. Anomalies are absorbed-and-retried against ground truth, not halted to a human (human gates = MERGE + escalations).
- **Durability / exactly-once:** every step is journalled; on crash-resume a succeeded `workflow_step` returns its recorded result and is never re-run; external effects carry an idempotency key + a probe of external state before applying.
- **One writer:** only the daemon writes SQLite; agents/workers return results that the daemon persists — explain why two writers is the deleted bug class.
- **Outward writes:** state changes enqueue into `projection_outbox` in the same transaction; the projector drains it to Linear/GitHub one-way; the loop never reads Linear/GitHub for control flow.
- **Implement fans out:** implement decomposes into per-`work_unit` dispatches tagged by `kind`; UI is a frontend work-unit + a visual verify check-type, **not** a stage.
- **Where the human shows up:** the needs-you inbox (resume / after-fix / abandon) and the MERGE gate; everything else loops.
- Close with a "Read next" pointer to `control-loop.md` for the step-by-step S1–S10 catalog.

- [ ] **Step 2: Verify vocab + that referenced docs exist**

Run:
```bash
grep -niE '\b(brainstorming|implementing|reviewing|releasing)\b|\bui stage\b' docs/architecture/execution-model.md
for f in $(grep -oE '[a-z0-9-]+\.md' docs/architecture/execution-model.md | sort -u); do
  [ -e "docs/architecture/$f" ] || echo "BROKEN: $f"; done
```
Expected: no output from either command.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/execution-model.md
git commit -m "docs: add execution-model concept doc (how a ticket is executed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: README rewrite — `README.md`

Replace the stale 820-byte "building the substrate" README with a real front door. Follow the converged OSS anatomy, adapted to a run-mode tool: hero → badges → demo → killer command → qualification → architecture diagram → router links → develop → license.

**Files:**
- Modify: `README.md` (full rewrite)

**Interfaces:**
- Consumes: links to `docs/architecture/README.md` (Task 1), `docs/architecture/execution-model.md` (Task 3), `SECURITY.md` (Task 5), `CONTRIBUTING.md` (Task 6), `docs/plans/`, `docs/architecture/`.
- Produces: the canonical project front door. The animated cast slot is filled by Task 9.

- [ ] **Step 1: Read the current README so the rewrite is a deliberate replacement**

Run: `cat README.md`
Expected: the current 6-section dev-only README (note its `migrate`/`build` commands so they are preserved accurately).

- [ ] **Step 2: Write the new README**

Section order and required content (real prose, no placeholders):
1. **Title + one-sentence tagline** naming the category: e.g. *"The free, open-source execution core that drives a structured ticket `design → implement → verify → review → merge → released` with minimal human involvement."*
2. **Badge row:** CI status (link to `.github/workflows/ci.yml`), latest release/version, license GPLv3. Use shields.io badges pointing at `Twinning-Labs/styre`.
3. **Demo slot:** an HTML comment placeholder `<!-- demo cast injected by Task 9: docs/assets/demo.svg -->` immediately under the badges, plus a **static ASCII architecture diagram** as the always-present fallback (ticket → daemon (single writer / SQLite SoT) → dispatched agents in isolated worktrees → projector → Linear/GitHub). The ASCII diagram ships now; the SVG augments it later.
4. **Killer command:** a fenced block showing the headline use — `styre run <TICKET-ID>` — with one line that stdout carries NDJSON telemetry and stderr carries the human summary.
5. **"Is this for you" / "Not for"** paired bullet lists (qualification-first). *Not for*: teams wanting a hosted/zero-setup product (that's the commercial Control Plane), non-Linear/non-GitHub shops, anyone expecting auto-merge (the operator merges every PR personally).
6. **What it is (open-core framing):** the OSS core is the same software, terminating at **PR-ready**; the commercial Control Plane is the layer above (continuous pickup, daemon, inbox, scheduling). One plain line: GPLv3.
7. **How it works:** 3–5 sentences pointing at `docs/architecture/execution-model.md`; name the trust story up front — **capability isolation** (agents get no creds/`gh`/Linear; the worktree is the only writable surface; the daemon holds creds and commits).
8. **Commands:** the real OSS surface only — `styre setup <repo>`, `styre run <ticket>`, `styre migrate`. Do **not** list `daemon`.
9. **Documentation router:** bullet links to `docs/architecture/README.md` (architecture index), `docs/architecture/execution-model.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/plans/`.
10. **Develop:** preserve the existing working block verbatim — requires Bun; `bun install` / `bun test` / `bun run lint` / `bun run build` (→ `dist/styre`) / `./dist/styre --version` / `./dist/styre migrate`.
11. **License:** GPLv3, link `LICENSE`.

- [ ] **Step 3: Verify the README does not claim a daemon command or use legacy vocab**

Run:
```bash
grep -niE 'styre daemon|\b(brainstorming|implementing|reviewing|releasing)\b|\bui stage\b' README.md
```
Expected: no output. (If `daemon` appears only in the open-core "layer above" framing as a *commercial* feature, that is allowed — but `styre daemon` as a command must not appear.)

- [ ] **Step 4: Verify all internal links resolve**

Run:
```bash
for f in $(grep -oE '\]\(([^)]+\.(md|sql))\)' README.md | sed -E 's/\]\(|\)//g'); do
  [ -e "$f" ] || echo "BROKEN: $f"; done
```
Expected: no `BROKEN:` lines. (`docs/architecture/README.md`, `execution-model.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` must all exist — order this task after Tasks 1, 3, 5, 6, or create those files first.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README as a real OSS front door

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `SECURITY.md` — isolation, egress, and vulnerability reporting

Table stakes for an agent that merges real code. Consolidate the security story into one page (avoid OpenHands' scatter-across-three-pages mistake). GitHub renders a "Report a vulnerability" affordance from this file.

**Files:**
- Create: `SECURITY.md`

**Interfaces:**
- Consumes: the capability-isolation and telemetry facts from Global Constraints.
- Produces: `SECURITY.md` at repo root (GitHub lookup precedence: `.github/` → root → `docs/`; root is fine).

- [ ] **Step 1: Write `SECURITY.md`**

Required sections (actual content):
- **Supported versions:** a short statement (pre-1.0; security fixes land on `main` / latest release).
- **Reporting a vulnerability:** use GitHub private security advisories ("Report a vulnerability" on the Security tab) as the primary channel; give an expected acknowledgement window; ask reporters not to open public issues for vulns.
- **Capability isolation (the model):** agents receive no `gh`/Linear tools and no ambient `LINEAR_API_KEY`; the worktree is the **only** writable surface; the daemon holds all credentials and performs every commit. Frame this as the lead safety property.
- **Human gates:** the operator merges every PR personally — no auto-merge — so no agent-authored code reaches `main` without a human.
- **Data egress / telemetry:** state plainly that the OSS core **does not phone home**. `styre run` emits NDJSON telemetry to **stdout** and a human summary to **stderr**; library callers default to emitting nothing (`noopSink`). There is no background network collection. Operators who pipe stdout choose where that data goes. Note that operator-supplied credentials (Anthropic / Linear / GitHub) are used only for the run and never transmitted to any Styre-operated service.

- [ ] **Step 2: Verify the no-phone-home claim is stated and accurate**

Run:
```bash
grep -niE 'phone home|stdout|noopSink|egress' SECURITY.md
```
Expected: at least the stdout + no-phone-home statements present.

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "docs: add SECURITY.md (capability isolation, no-phone-home telemetry, vuln reporting)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `CONTRIBUTING.md` — dev loop + workflow rules

**Files:**
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the dev commands from `package.json` and the workflow rules from CLAUDE.md.
- Produces: `CONTRIBUTING.md` at repo root, linked from README.

- [ ] **Step 1: Write `CONTRIBUTING.md`**

Required content:
- **Prerequisites:** Bun (link bun.sh).
- **The dev loop:** `bun install`, `bun test`, `bun run lint` (Biome), `bun run typecheck`, `bun run build` (→ `dist/styre`). Show each as a command.
- **Workflow rules (hard):** never commit to `main`; branch with `feat/` for features/improvements and `fix/` for bug fixes; merge back via PR only; **no auto-merge ever — the operator merges every PR personally** (no `gh pr merge`, no `--auto`); your job ends at "PR is open and ready."
- **Where things go:** brainstorms → `docs/brainstorms/`, plans → `docs/plans/`, durable design docs → `docs/design/`; the frozen substrate spec lives in `docs/architecture/` (start at its `README.md`).
- **Before you change anything:** read the architecture docs in order (link `docs/architecture/README.md`); respect the load-bearing invariants (single writer, one-way projection, ground-truth verdicts, clean-break stage vocab, capability isolation).
- **Commits:** Conventional Commits (the CHANGELOG is generated by git-cliff from them).
- **Architecture for contributors:** one line pointing at `docs/architecture/README.md` rather than duplicating it (the Continue/ripgrep "thin CONTRIBUTING that points at depth" pattern).

- [ ] **Step 2: Verify the no-auto-merge rule and branch prefixes are present**

Run:
```bash
grep -niE 'auto-merge|gh pr merge|feat/|fix/' CONTRIBUTING.md
```
Expected: matches for the no-auto-merge rule and both branch prefixes.

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING.md (dev loop + workflow rules)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `CODE_OF_CONDUCT.md`

Standard Contributor Covenant — low-cost community-health signal.

**Files:**
- Create: `CODE_OF_CONDUCT.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `CODE_OF_CONDUCT.md` at repo root.

- [ ] **Step 1: Add the Contributor Covenant v2.1 verbatim**

Use the official Contributor Covenant version 2.1 text (https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Fill the enforcement-contact placeholder with the project security/abuse contact (the same GitHub-advisory channel referenced in `SECURITY.md`, or a maintainer email — confirm the value with the operator before finalising; do not invent an address).

- [ ] **Step 2: Verify the contact placeholder was filled**

Run:
```bash
grep -niE '\[INSERT CONTACT|enforcement' CODE_OF_CONDUCT.md
```
Expected: no `[INSERT CONTACT` placeholder remains; an enforcement section is present.

- [ ] **Step 3: Commit**

```bash
git add CODE_OF_CONDUCT.md
git commit -m "docs: add Contributor Covenant code of conduct

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `.github/` issue and PR templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:**
- Consumes: nothing (sits alongside the existing `.github/workflows/`).
- Produces: GitHub "New issue" chooser + auto-filled PR body.

- [ ] **Step 1: Write `bug_report.yml`**

A GitHub issue **form** (`.yml`) with: name/description/labels (`bug`); fields for Styre version (`styre --version`), OS (macOS/Linux), the subcommand involved (`run`/`setup`/`migrate`), reproduction steps, expected vs. actual, and relevant stderr summary / NDJSON lines. Mark repro + version required.

- [ ] **Step 2: Write `feature_request.yml`**

Issue form with: labels (`enhancement`); problem statement, proposed solution, and an explicit "does this belong in the OSS core or the commercial plane?" prompt (so scope is triaged early, matching the open-core boundary).

- [ ] **Step 3: Write `config.yml`**

Set `blank_issues_enabled: false` and a `contact_links` entry pointing security reports to the Security advisory tab (so vulns don't land as public issues).

- [ ] **Step 4: Write `PULL_REQUEST_TEMPLATE.md`**

Checklist body: what/why, linked ticket, `bun test` + `bun run lint` pass, docs updated if behaviour changed, and a reminder line: *"Do not enable auto-merge — the operator merges manually."*

- [ ] **Step 5: Verify the YAML forms parse**

Run:
```bash
for f in .github/ISSUE_TEMPLATE/*.yml; do bun -e "import('node:fs').then(fs=>require('node:util'))" >/dev/null 2>&1; python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" && echo "OK $f"; done
```
Expected: `OK` for each `.yml` (uses the system `python3` yaml parser; if unavailable, visually confirm valid YAML indentation instead).

- [ ] **Step 6: Commit**

```bash
git add .github/ISSUE_TEMPLATE .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs: add issue forms and PR template

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Animated demo cast (asset + tooling + README wiring)

The single highest-impact above-the-fold element: an asciinema-style SVG of a ticket progressing, that animates natively in GitHub and is version-controlled. **Scope note (explicit, not silently deferred):** generating the *recording* requires a real `styre run` against a live ticket, which depends on operator credentials and a target repo. This task sets up the deterministic tooling + script and wires the README slot; the **recording capture is flagged for the operator** and may land in a follow-up commit. The README ASCII diagram from Task 4 is the always-present fallback, so the front door is never broken if the cast is pending.

**Files:**
- Create: `scripts/record-demo.sh`
- Create: `docs/assets/.gitkeep` (until `docs/assets/demo.svg` is captured)
- Modify: `README.md` (replace the demo HTML comment with the `<img>`/`<picture>` once the SVG exists)
- Modify: `package.json` (optional `devDependency` for the recorder, only if the chosen tool is npm-distributed)

**Interfaces:**
- Consumes: a runnable `styre run` (operator-provided) or a scripted transcript stand-in.
- Produces: `docs/assets/demo.svg` + a reproducible `scripts/record-demo.sh` (the fd/Aider "checked-in regeneration script" pattern).

- [ ] **Step 1: Write `scripts/record-demo.sh`**

A documented script that records a terminal session to SVG using `agg` (asciinema → gif/svg) or `svg-term-cli`. It must: state the recorder dependency at the top, capture a `styre run <DEMO_TICKET>` session (or a `--dry`/scripted transcript if no live ticket), and emit `docs/assets/demo.svg`. Include a comment block explaining how to install the recorder and that the SVG is committed (not generated at build time).

- [ ] **Step 2: Decide capture path with the operator**

This step is a **gate, not code**: confirm with the operator whether to (a) capture a real run now (needs creds + a demo ticket) or (b) ship the ASCII fallback and capture the SVG in a follow-up. Record the decision in the PR description. Do not fabricate a fake transcript that misrepresents real behaviour.

- [ ] **Step 3: If captured, wire the README slot**

Replace the `<!-- demo cast injected by Task 9 -->` comment with:
```html
<p align="center"><img src="docs/assets/demo.svg" alt="styre run driving a ticket from design to merged" width="800"></p>
```
If not captured, leave the ASCII fallback and the comment in place.

- [ ] **Step 4: Verify**

Run:
```bash
test -f scripts/record-demo.sh && echo "script present"
grep -q 'docs/assets/demo.svg' README.md && echo "README references SVG" || echo "README still on ASCII fallback (expected if capture deferred)"
```
Expected: script present; the README line reports whichever state was chosen in Step 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/record-demo.sh docs/assets/.gitkeep README.md package.json
git commit -m "docs: add demo-cast tooling and wire README slot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Tier 3 — Deferred (documented, not built)

These are **deliberately out of scope** for this plan; recorded so the deferral is explicit, not silent:
- **A hosted docs site** (Mintlify/Starlight `Quickstart → Concepts → Guides → Reference → Operate` + `llms.txt`). Defer until the user-facing surface outgrows the README + in-repo markdown. ripgrep/fd/bat ship none.
- **A `GUIDE.md` long-form user walkthrough.** Add when `setup`/`run` grow enough options to need recipes beyond the README.
- **A public telemetry/aggregate dashboard.** Only meaningful once the commercial plane consumes the stdout stream at scale.
- **A CLA / `GOVERNANCE.md`.** Worth considering to protect the open-core seam ("never fork the core"), but it is a policy decision for the operator, not a docs task.

## Self-Review

- **Spec coverage:** Every recommendation from the research synthesis maps to a task — README rewrite (T4), animated cast (T9), SECURITY/CONTRIBUTING/CODE_OF_CONDUCT (T5/T6/T7), `.github/` templates (T8), architecture index (T1), execution-model + glossary concept docs (T3/T2), telemetry disclosure (folded into T5 per the no-phone-home finding), open-core framing (T4 §6 + T5), docs-site/GUIDE/dashboard/CLA (Tier 3 deferred, explicit).
- **Ordering / dependency note for the executor:** Task 4 (README) and Task 7's contact and Task 8's config link to files created in Tasks 1, 3, 5, 6 — execute **1 → 2 → 3 → 5 → 6 → 7 → 8 → 4 → 9**, or create the linked files before running Task 4's link-check step. Each task is independently reviewable.
- **Placeholder scan:** intentional placeholders are only the README demo-comment slot (filled by T9) and the CoC contact (T6/T7 gate with the operator) — both flagged as gates, not silent TODOs.
- **Vocab consistency:** clean-break stage vocabulary enforced by a grep guard in Tasks 1, 2, 3, 4; no `styre daemon` command enforced in Task 4.
