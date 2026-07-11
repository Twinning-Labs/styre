# Changelog

All notable changes to this project are documented here.
## [0.7.0] - 2026-07-11

### Features

- **Slack notifications:** styre can now post to Slack for escalations, terminal states, and (at higher verbosity) stage transitions, so you can follow ticket progress without watching the CLI directly.
- Slack messages include the ticket title and a "View PR" button linking to the pull request, formatted with Slack's rich Block Kit layout.
- Dead-end `blocked` terminals now trigger a Slack notification distinct from escalation-blocked cases, so you get exactly one message per outcome instead of none or duplicates.
- Added a `styre notify --test` command to send a test Slack message and confirm your bot token and channel configuration are working.
- Set `SLACK_BOT_TOKEN` and configure your notification policy and channel in `config.json` to turn this on; styre fails loudly at startup if the configuration is incomplete.

### Bug Fixes

- Slack delivery failures are now surfaced with clearer diagnostic messages instead of failing silently, and they never cause a ticket to be escalated on their own.

## [0.6.4] - 2026-07-11

### Bug Fixes

- **`checks:dispatch` can now catch its own vacuous checks:** the check-authoring agent has scoped `Bash` access (limited to the project's real runner commands) so it can run the check it just wrote and confirm it actually fails on the current, unfixed code before finishing, instead of submitting an unverified check that happens to pass on broken code.
- Sharpened the authoring guidance to steer toward discriminating assertions for numeric, data, and algorithmic acceptance criteria, rather than assertions that hold true regardless of whether the fix is correct.
- Feedback for a caught vacuous check now spells out that it passed on the broken code and tells the re-authoring pass to confirm the check fails (RED) before finishing, making retries more likely to converge.

## [0.6.3] - 2026-07-11

### Bug Fixes

- **Code review findings now reach the implement agent when work is bounced back for re-coding.** Previously, only verify feedback and still-failing acceptance criteria were passed along on a review-triggered loopback, so the implement agent had no idea what the review actually flagged. This caused the same finding to be raised again on the next review, and styre would eventually give up with a "no progress: identical review findings" error. The blocking findings from the latest review are now surfaced to the implement agent from the very first loopback.
- **The checks agent is now told not to leave scratch or debug files behind, and how to declare legitimate helper files.** Since a recent change, any undeclared new file causes a commit to be rejected and retried, but the checks prompt never explained this or gave the agent a way to declare a genuine non-test helper file (like a fixture or `conftest.py`). Without that guidance, the agent could re-create the same scratch file on every retry and get stuck in a reject-and-retry loop until it ran out of attempts. The checks prompt now includes the same anti-scratch guidance and `new_files` declaration field that the implement prompt already had.

## [0.6.2] - 2026-07-11

### Bug Fixes

- **Fixed checks being marked as run when they actually failed to run.** Previously, a check that errored out (for example, due to an empty diff, missing components, or an infrastructure crash) was incorrectly treated as a completed check, which let the ticket advance instead of retrying — silently skipping the failure-recovery retry logic. Errors now correctly trigger a bounded retry before escalating.
- **Rejected authors no longer leave invalid files behind.** When an author's work is rejected during check dispatch, the branch is now rolled back to the state before that author ran, so invalid or incomplete test files no longer pollute the eventual pull request or contaminate the next retry.
- **Fixed stale external state after loopback corrections.** When a ticket is sent back from review to implementation or design for corrective work, the stage change is now properly synced to external systems, so those systems no longer show outdated status during the correction.
- **Fixed missed updates when a ticket re-enters a stage.** State updates are now tracked per correction cycle, so re-entering a stage after being sent back for rework is no longer mistakenly treated as a duplicate and dropped.

## [0.6.1] - 2026-07-11

### Bug Fixes

- **Dispatch commits no longer sweep up agent scratch files.** Previously, styre committed every changed file after each dispatch step, which could pull in stray reproduction scripts and debug files that the agent created but never intended to include. Each step now only commits the files it actually declares as its deliverable, so leftover scratch files are either left uncommitted (with a note in the event log) or cause the step to fail loudly and retry rather than silently polluting the diff.

## [0.6.0] - 2026-07-10

### Features

- **Change-scoped verify** is now fully wired end-to-end: styre derives a ground-truth check per acceptance criterion, authors and runs it RED-first on a clean baseline, classifies persistent red as either a code problem or a wrong-shape check, and gates merges on the checks that actually encode your acceptance criteria rather than the whole test suite.
- When an AC-check stays red after implementation, styre now adjudicates the blame instead of looping blindly: it either sends the ticket back to implement (code is wrong) or re-authors the check itself (the check is wrong), validating any re-authored check is genuinely red on a clean baseline before trusting it.
- The whole component test suite and integration checks are now advisory rather than blocking, since without a pre-change baseline they can't reliably distinguish pre-existing failures from regressions; they're still recorded for review.
- Pull request descriptions now include a "Change-scoped verify" section at merge time, showing exactly which acceptance criteria were verified, satisfied, not checkable, or re-authored — including a call-out whenever a check had to be corrected, so the merge decision is never based on an overstated report.
- The `design` and `design:review` prompts are sharper: the design agent is now told to inspect the actual repo before planning, present work units in a scannable labelled format, and map each acceptance criterion to the work that satisfies it; the review prompt has calibrated severity levels and clearer guidance on what to actually judge versus what's already mechanically checked.

### Bug Fixes

- Fixed a crash where a `docs:revise` step had no handler at all, which could wedge a ticket's workflow indefinitely.
- When a dispatch step fails its own check (for example, a malformed report or a rejected extraction), retrying that step now includes the specific reason it failed, so the agent can fix the actual problem instead of repeating the same mistake.
- Fixed a case where a blocking finding from code review could trigger a redesign without carrying the reviewer's actual feedback along, leaving the redesign blind to why it was sent back.

## [0.5.0] - 2026-07-07

### Features

- **Codex is now a supported agent provider.** You can configure `styre` to run tickets through OpenAI's `codex` CLI instead of Claude by adding an `agent` block to `config.json`; Claude remains the default when nothing is configured.
- **`styre run` and `styre setup` now work without path flags.** Set up your profile and workspace config once under `~/.config/styre` (globally or per-project), then run `styre run ENG-123` from inside any project directory and it discovers the right config and profile automatically. Explicit `--profile`/`--config` flags still work exactly as before for hermetic overrides.
- **Release notes are now written in plain language.** GitHub releases and `CHANGELOG.md` entries describe what changed for users rather than listing raw commit subjects.

### Bug Fixes

- **Design review feedback no longer gets lost on redesign loops.** When a plan review sends a ticket back for redesign, per-unit findings (like decomposition or feasibility issues on a specific work unit) now carry through to the redesign instead of being silently discarded, so the redesign actually addresses what the reviewer flagged.
- **Design review loops converge instead of looping forever on already-correct plans.** A ticket sent back from review for redesign now checks its own updated plan (not an unrelated fresh commit) and gets the reviewer's actual feedback passed along, so a nearly-right plan can pass review on the next pass instead of bouncing indefinitely.

## [0.4.0] - 2026-07-06

### Features
- Deterministic completeness step (fixes the empty-diff false-block) (#49)
- Verify reuses a ready env instead of rebuilding (#51)
- In-place execution for disposable checkouts (branch in the repo root, not a worktree) (#52)


## [0.3.0] - 2026-07-04

### Features
- Setup→verify security hardening (F1–F4 + A1) (#43)
- Polyglot detectors + registry engine (M-B / M-C1) (#44)
- Design stack-awareness (WO-13) + AGENTS.md command source (WO-4) (#45)
- File-identity routing (WO-5, schemaVersion 3) + sweep cost (WO-6) (#46)
- Ruby/PHP (WO-3) + non-root manifests (WO-9) + enrichment fail-soft (#47)
- Provision step — styre readies its own verify env (C1) (#48)


## [0.2.0] - 2026-06-27

### Documentation
- Update README.md with the runes for the noun and verb forms of styre (#41)


### Features
- Anonymized opt-out PostHog adoption analytics for the OSS CLI (#42)


## [0.1.2] - 2026-06-26

### Bug Fixes
- Scope release notes to the version + restore item line breaks (#37)
- Rename event_log.actor enum 'daemon' → 'runner' (OSS single-writer terminology) (#40)


### Documentation
- Documentation front door (README rewrite, architecture index, community-health files) (#38)
- Make documentation internally consistent for the OSS core (daemon→runner boundary, brew install, Develop fixes) (#39)


## [0.1.1] - 2026-06-25

### Bug Fixes
- MacOS-only brew smoke + unified linux tarball smoke matrix (#36)


## [0.1.0] - 2026-06-25

### Bug Fixes
- Match --version only as the top-level flag
- Ad-hoc re-sign the compiled binary on macOS so it runs
- AdvanceOneStep propagates StepInFlightError instead of mis-routing it to failure-policy
- RunCommand returns promptly on timeout (Linux CI hang)
- Reset the unit's coding step on bounce-back so re-verify converges
- Exclude advisory scope_diff from re-coding feedback
- IsTestFile recognizes .mjs/.cjs/.mts/.cts test files
- Revert review_finding schema change + drop superseding; test no-progress guard
- Re-drop superseding + revert schema (operator decision); flow 2 via dispatch-scoping
- Merge-complete e2e — driveUntil throws on exhaustion + approval throw-guard
- Paginate GitHub probes, surface git-push stderr, zod-validate forge payloads
- Scrub LINEAR_API_KEY/GITHUB_TOKEN from the agent subprocess env (capability isolation)
- Paths test must delete (not =undefined) to unset env
- Close capability-isolation + crash-safety gaps from codebase audit
- Make the agent-dispatch timeout a hard bound (M1)
- Close capability-isolation + crash-safety gaps (#24)
- Restore D5 documentation soft-nudge-when-absent
- Tighten out-of-credits marker; cover resetAt-null fallback (ENG-164)
- Add deps DI seam to resumeRun + stale-worktree cleanup before re-dispatch
- Rewrite resumeParkedTicket to drive real resumeRun via DI seam
- Inject resumeRun deps for real-path test coverage; clean stale parked worktree on resume (ENG-164)
- Make a park attempt-neutral so quota pauses never burn retry budget (ENG-164)
- Pick most-recent baseline so accept-head survives a later re-park (ENG-164)
- Scope implement Bash to the unit's components; never bare unscoped Bash
- Close command injection in probeCommandExists (Task 8 review Critical)
- Guard Cargo.toml read in cargoWorkspaceMembers (whole-branch review Minor)
- Run build.sh with sh, not bun run (Bun Shell breaks the build) (#34)


### CI
- Add CI workflow, compile-smoke, and README


### Chores
- Enable Biome organizeImports
- Enable Biome organizeImports (#9)
- Close deferred review minors (error-class test, N1 field asserts, cosmetics)
- Biome format + lint sweep across the runtime-context branch
- Sweep deferred review minors (backoff trim, tauri detail, test coverage)
- Enforce docs-path convention with a PreToolUse hook
- Close carried minors — timeout→transient assert, event_log.kind union, harness temp cleanup (ENG-164)
- Untrack accidentally-committed SDD scratch file + ignore .superpowers/
- Untrack accidentally-committed SDD scratch file + ignore .superpowers/ (#30)


### Documentation
- Import Styre substrate spec + build/operations
- Make installation dual-target (macOS + Linux)
- No fork — telemetry export is structured stdout (OSS core)
- No fork — telemetry export is structured stdout (OSS core) (#1)
- Add CLAUDE.md project guidance
- Add CLAUDE.md project guidance (#2)
- Add docs-layout convention + scaffolding design brainstorm
- M0 skeleton implementation plan
- Scaffolding plan — docs convention, scaffolding brainstorm, M0 plan (#3)
- M1 durable-core implementation plan
- Document pure/effectful step-journal design; refactor(m1): wrap consumeSignal in a transaction
- M2a resolver data layer + pure state machine plan
- M2b resolver execution loop + walking skeleton plan
- M3a dispatch infrastructure plan
- M3b real-dispatch plan
- Provider-agnostic agent boundary design (supersedes Claude-specific dispatch)
- Rewrite M3b as provider-agnostic real dispatch
- M4a ground-truth verify execution plan
- M4b-a verify-failure routing core plan
- M4b-b diff-inspection gates + feedback plan
- M5a design:extract plan-to-work-items plan
- M5b-1 code review gate plan
- M5b-1 — drop superseding from verdict spec (operator decision; dispatch-scoping suffices)
- Fix stale config path ref (runtime-config.ts)
- M5b-2 plan review + track sizing plan
- M5b-3 complexity grader plan
- M6a projector substrate + issue-tracker port (Linear) plan
- M6b-1 forge port (GitHub) + merge-write path plan
- Added all the remaining plan documents
- Added all the remaining plan documents (#25)
- Defer the per-ticket ticket-contract feature to the commercial product
- Defer per-ticket ticket-contract to the commercial product (#26)
- Profile runtime-context (CDOT) design spec
- Profile runtime-context (CDOT) implementation plan
- Sync Task 5 test fixture to the committed all-absent base
- Agent-prose enrichment spec (D4 second half)
- Agent-prose enrichment implementation plan
- Transport-failure cause classification spec (ENG-164)
- Transport-failure cause classification implementation plan (ENG-164)
- Document the parked/resume CLI seam + control-loop atlas note (ENG-164)
- Brainstorm — polyglot-monorepo support (foundation design)
- Revise polyglot-monorepo design after independent review
- Polyglot-monorepo implementation plans (runtime + detection)
- Revise polyglot-monorepo plans after independent review
- Close second-review findings on polyglot plans
- Sync base_sha column into doc mirror (Task 2 review finding)


### Features
- Bun project scaffold + styre --version
- Styre migrate — SQLite self-bootstrap from canonical schema
- UTC time util, project/ticket repos, and test DB helper
- Workflow_step repo (journal row data access)
- Step journal — replay, write-ahead intent, exactly-once effects
- Durable signals — park/deliver/consume wait primitive
- Recover() — reconcile crash-interrupted running steps
- Work_unit repo (decomposition row data access)
- Ticket repo track/needs_docs/stage setters + signal hasDelivered
- Ground_truth_signal + event_log repos
- Step-handler registry + handler contract
- NextStepKey pure state machine (design→released routing)
- Failure-policy shape (bounded retry / verify loopback / escalate)
- Advance_one_step — interpret resolver descriptors
- Loop tick() — v_ready_tickets selection + K concurrency
- Dispatch repo (per-invocation record)
- Model-tier resolution + per-step tool allowlists
- Project-profile loader + zod schema
- Render-prompt engine + CL-PROFILE placeholder gate
- Zod-validated sidecar extractor (absent vs malformed)
- Git worktree manager (CL-COMMIT, daemon-commits)
- Workflow_step.setPid + ticket branch fields + branchNameFor
- Provider-agnostic agent boundary (AgentRunner/tiers/config/registry); retire models.ts
- Claude provider adapter (spawn + arg/json helpers)
- Prompt templates + dispatch-vars builders
- RunAgentDispatch orchestration (provider-agnostic, tier→model)
- Real design:dispatch + implement:dispatch handlers + registry
- RunCommand profile-command runner (timeout + capture)
- Record profile command on ground_truth_signal
- Real verify:check handler (S3) — daemon-run ground truth
- Real verify:integration handler (S4)
- Stamp check results with the verified commit + current-commit lookups
- Verify handlers stamp the verified commit; could-not-run maps to error
- Content-keyed re-verification (pass-at-current-commit)
- Re-open all unit checks on bounce-back; route by kind; escalate repeats
- Integration failure spawns a reconcile work-unit (N1)
- Escalate to deep tier when re-implementing after a bounce-back
- Diff-inspection substrate (changedFilesAt, parseFilesToTouch, isTestFile, testFilePattern)
- Behavioral gate — test must be in the coding diff (A1)
- Scope_diff advisory note (never gates the step)
- Feed verify failures back into the re-coding prompt (incl. add-a-test)
- Persist work_unit title/description/test_plan in insertWorkUnit
- Surface agent stdout as runAgentDispatch output
- Extract sidecar schema + deterministic completeness check
- Design-extract prompt + extractVars
- Real design:extract handler (sidecar → validated work_units)
- Review_finding repo
- Findings sidecar schema + blocks_ship computer
- Review prompt + handler (findings sidecar → review_finding rows)
- RuntimeConfig (onPlanDefect) + review verdict (loopback/escalate machinery)
- Wire review verdict into advanceOneStep + tick
- Deterministic sprawl-only track sizer wired into design:extract
- Design:review prompt + handler (plan findings → review_finding rows)
- Step-keyed dispatch lookup (latestDispatchForStep)
- Plan-review verdict (blocking → re-design) + step-scoped findings
- Fire the verdict after design:review (verdict-bearing-step set)
- ComplexityGrading flag + thread RuntimeConfig into HandlerContext
- Complexity grade schema + combineTrack (complexity-leads, sprawl-floor)
- Design:size step owns sizing (sprawl path) + resolver routes on track=null
- Cold complexity grader on-path (config-gated) + tier/allowlist
- Neutral outbox target (issue_tracker/forge) + projection_outbox repo
- IssueTrackerPort + selectIssueTracker factory + fake adapter + config field
- DrainOutbox projector (neutral-role dispatch, idempotent, retry+escalate)
- Enqueue stage-transition projections in the advance transaction
- Official-SDK Linear adapter (IssueTrackerPort)
- Drain the outbox each tick (ports injected); enqueue→drain e2e
- ForgePort + selectForge factory + fake forge + config field
- Official-Octokit GitHub forge adapter (+ git push)
- Drainer forge dispatch arm (push/pr_create/pr_comment)
- Merge:push + merge:pr-ensure handlers (enqueue forge ops; templated PR body)
- Released:project handler (best-effort worktree cleanup)
- ChecksPort + selectChecks + fakeChecks (vendor-neutral checks port)
- GitHub checks adapter via shared githubClient (@octokit firewall preserved)
- Drainer delivers external_pr_result + recordDelivered/listPendingByType helpers
- PollChecks delivers external_checks (none auto-pass / github poll) + tick wiring
- Ticket.description column + insertTicket ingestion fields
- Thread ticket description into the design prompt
- FetchTicket ingestion read (IssueTrackerPort + Linear + fake) + ticket-source contract
- MakeProjectorPorts factory (config + env creds → ProjectorPorts)
- DriveToTerminal — bounded run driver with pr-ready/blocked/no-progress detection
- Styre run command — ingest a ticket, drive to PR-ready, telemetry summary
- ConfigDir() XDG path helper
- Pure stack detectors (package manager, commands, checks-system)
- ProbeProfile — git+stack probe into a validated Profile
- Styre setup command — probe a repo, write the profile JSON
- Telemetry event schema (versioned union) + stdout/noop sinks
- Telemetry emitter (row mappers + dedup flushNew + summary) + signal listByTicket
- Emit telemetry per-tick to stdout (human summary → stderr)
- Capture cache tokens on dispatch; retire metric_event as a carry
- Capture cache tokens on dispatch; retire metric_event as a carry (#27)
- Add schemaVersion + runtimeContext (CDOT) block
- Deterministic runtime-context probe (flags + terse detail)
- Bubble up unknown runtime-context sections to the operator
- Merge-preserving re-probe (--reprobe for clean regen)
- CdotImpact schema + profile-consistency gate
- Enforce CDOT gate + set needs_docs; thread runtime vars into prompts
- Enrichment schema + scan/agent merge (scan flags ground truth)
- EnrichRuntimeContext — bounded-retry setup-time agent call
- Wire mandatory agent enrichment into runSetup + key precondition
- Profile runtime context (CDOT) — probe, gate, forcing functions (#28)
- Provider-neutral FailureCause + Claude marker classifier (ENG-164)
- Event_log 'parked' kind + payload_json plumbing (ENG-164)
- ParkSignal + route park-causes in runAgentDispatch (ENG-164)
- Propagate ParkSignal to a 'parked' run outcome, burning no attempt (ENG-164)
- Dump a parked run to the XDG state dir and exit 75 (ENG-164)
- Styre run --resume with step-granularity rehydrate + transcript carryover (ENG-164)
- Add getLatestWorktreePath helper for resume stale-worktree cleanup
- Classify transport-failure cause — resumable park for quota/billing, retry for crash (ENG-164) (#29)
- Components[] model + routing helpers (polyglot foundation)
- Cumulative per-unit diff via base_sha + changedFilesBetween
- Three-way per-component routing; absent=error; reviewer-only degrade + PR-visible untested-merge-risk
- Integration runs all components' build/test + repoCommands
- Source test_command from the unit's impacted components
- Polyglot-monorepo foundation — design + Plan 1 (runtime) (#31)
- Deterministic component scan (manifests + cargo workspace collapse)
- Read-only component-discovery agent + reconciliation merge + command probe
- Interactive command-resolution ladder + scriptRunner warnings + run-time guard
- Polyglot-monorepo foundation — Plan 2 (detection/setup) (#32)
- Homebrew distribution — release CI + dedicated tap (ENG-222) (#33)
- Modernize macOS runners (macos-15 + macos-15-intel) + node24 actions (#35)


### M0
- Skeleton — Bun scaffold, styre --version, styre migrate, CI (#4)


### M1
- Durable core — step journal, signals, idempotency, recover (#5)


### M2a
- Resolver data layer + pure nextStepKey state machine (#6)


### M2b
- Resolver execution loop + walking skeleton (#7)


### M3a
- Dispatch infrastructure (no claude -p) (#8)


### Refactor
- Address review nits (last-block sidecar, tighter assertions, type narrowing)
- Extract finishRunResult so park exit-code is real-path tested (ENG-164)


### Tests
- Assert the keyed effect is re-attempted (at-least-once) in the exactly-once test
- Assert event_log actor default + ordering; cover gts measured_at + null detail
- Direct tests for nextActionableUnit dep-gating, blocked path, nextUnrunCheck ordering
- Walking-skeleton e2e (design→released) + crash-resume
- Cover runAgentDispatch transport-failure path (dispatch-failed, no commit)
- Offline real-handler e2e + manual agent smoke + smoke doc
- Implement→verify e2e drives a work-unit to verified
- Cover repeated-failure→escalate (no-progress backstop)
- E2e fail→re-code→re-verify converges and keeps history
- E2e behavioral bounce-back converges + integration reconcile re-runs
- E2e review verdict flows (clean/re-code/escalate/redesign/defer)
- Restore design:review handler coverage via a non-blocking finding
- E2e plan-review flows (clean/redesign/escalate/fast-skip)
- Flow 4 drives the real sizer (1-unit extract → fast → skip design:review)
- E2e sizing flows (off/on) + decision-log entry
- E2e forge-write merge flow (push + PR → parks awaiting checks)
- Merge→released completion e2e (none auto-pass + github passing)
- HEAD-guard escape hatches + park-loop never burns an attempt (ENG-164)


### Style
- Biome format + import-sort on extract schema/prompt-vars


