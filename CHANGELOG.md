# Changelog

All notable changes to this project are documented here.
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


