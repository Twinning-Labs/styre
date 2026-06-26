-- ============================================================================
-- Styre — SQLite Schema  (substrate, v3)
-- ----------------------------------------------------------------------------
-- Artifact for §9.4 checklist #1 of docs/redesign/brainstorm.md.
-- Single transactional Source-of-Truth (design move 2). Replaces the current
-- 3-medium state machine: Linear labels + Linear comments + per-issue JSON.
--
-- v2 (2026-06-19) — coherence pass after the control-loop step-catalog walkthrough
--   (docs/redesign/control-loop.md). Realigned to the frozen loop model:
--     * removed the ticket skip-policy block (policy/exit_code/retry_count/… —
--       the new loop has no skip-until-* dance; failures escalate to a resumable
--       `waiting` + `human_resume`, progress tracked by failure-signature+budget).
--     * dropped `status='halted'` (P1: never a dead halt → use `waiting`).
--     * `pipeline_event` → lean **`event_log`** (control-decision audit:
--       transition / loopback / escalated / resumed) — verdicts are now DERIVED
--       from review_finding, not stored as markers.
--     * **`review_finding` realigned** to the new finding shape (single severity,
--       category, factors, deferral_candidate, runner-computed blocks_ship,
--       review_kind plan|code) — dropped the ENG-191 cold/adjudicated/decision shape.
--     * added `ticket.needs_docs`, `project.checks_system` (+config),
--       `ground_truth_signal.signal_type` now the open declared check-type.
--     * removed `dispatch.verdict_emitted`/`verdict_target` (runner derives verdicts).
--
-- SCOPE (hard boundary, §9.1 + §10): substrate only. The UGL / supervisor /
--   memory-RAG tables are post-cutover increments I-C/I-D — sketched (commented,
--   NOT created) at the end so the substrate stays forward-compatible.
--
-- INVARIANTS:
--   * Only the runner writes this DB (B2). Workers return results; the runner
--     journals them. Single-writer by construction. WAL gives concurrent readers.
--   * Idempotency keys are **globally unique BY CONSTRUCTION** (prefixed with the
--     dispatch_id / ticket ident), so the global UNIQUE is the dedup mechanism.
--
-- CONVENTIONS:
--   * Timestamps STORED as TEXT ISO-8601 UTC ('…Z'); DISPLAY converts to the
--     operator's LOCAL timezone at render time (DS-1). Storage is never local-tz.
--   * Enums via CHECK; booleans INTEGER 0/1 + CHECK; JSON guarded by json_valid().
--   * Surrogate INTEGER PK + natural UNIQUE keys; everything scoped by project_id.
-- ============================================================================

PRAGMA journal_mode = WAL;        -- persistent; single-writer + concurrent readers
PRAGMA foreign_keys = ON;         -- per-connection: the runner MUST set this each open
PRAGMA busy_timeout = 5000;       -- per-connection hint

-- ----------------------------------------------------------------------------
-- schema_meta — migration version marker
-- ----------------------------------------------------------------------------
CREATE TABLE schema_meta (
    version     INTEGER NOT NULL,
    applied_at  TEXT    NOT NULL,
    note        TEXT
);
INSERT INTO schema_meta (version, applied_at, note)
VALUES (3, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v3: event_log.actor enum daemon→runner (OSS single-writer terminology)');

-- ============================================================================
-- §A  PROJECT + TICKET   (replaces issue-state.json + stage:* / pipeline:* labels)
-- ============================================================================

-- project — per-PROJECT_SLUG namespace (the harness runs many targets; one runner).
CREATE TABLE project (
    id                  INTEGER PRIMARY KEY,
    slug                TEXT    NOT NULL UNIQUE,        -- PROJECT_SLUG (frozen at setup)
    target_repo         TEXT    NOT NULL,               -- absolute path on host
    default_branch      TEXT    NOT NULL DEFAULT 'main',
    linear_team_key     TEXT,                           -- e.g. 'ENG' (projector scope)
    config_json         TEXT CHECK (config_json IS NULL OR json_valid(config_json)),
    -- Checks system (CL-CHECKS): which system answers "are the checks green?" +
    -- how to reach it. One translator per kind; build 'github' + 'none' now.
    checks_system       TEXT CHECK (checks_system IS NULL OR checks_system IN ('github','external','none')),
    checks_config_json  TEXT CHECK (checks_config_json IS NULL OR json_valid(checks_config_json)),
    paused              INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),  -- global breaker
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

-- ticket — the per-ticket SoT row. One row per Linear issue under harness control.
--   `stage`  = pipeline POSITION (new C1 lifecycle), authoritative; the Linear
--             `stage:*` label is a projection of it.
--   `status` = lifecycle disposition (separate from stage). No `halted` — P1.
CREATE TABLE ticket (
    id                    INTEGER PRIMARY KEY,
    project_id            INTEGER NOT NULL REFERENCES project(id),
    ident                 TEXT    NOT NULL,                  -- 'ENG-5'
    linear_issue_uuid     TEXT,                              -- resolved lazily; for projection
    title                 TEXT,
    description           TEXT,                              -- the ingested ticket body (design input)

    -- Branch shape (load-bearing — prefix derives from type_label).
    type_label            TEXT CHECK (type_label IN ('Bug','Feature','Improvement')),
    branch_prefix         TEXT CHECK (branch_prefix IN ('fix','feat')),  -- Bug->fix else feat
    branch_name           TEXT,                              -- 'feat/ENG-5-slug' (empty pre-implement)
    branch_head_sha       TEXT,

    -- Pipeline position + disposition (new C1 lifecycle; DS-2 clean break).
    stage                 TEXT NOT NULL CHECK (stage IN (
                              'design',      -- brainstorm + plan fused
                              'implement',   -- decomposes into work_unit dispatches
                              'verify',      -- ground-truth verify (build/tests/scope)
                              'review',      -- independent cold-context reviewer (A4)
                              'merge',       -- human-gated (D2)
                              'released')),  -- terminal; post-merge wrap-up
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                              'active','waiting','abandoned','done')),  -- no 'halted' (P1)
    track                 TEXT CHECK (track IN ('fast','full')),        -- C2 sizing rubric
    needs_docs            INTEGER NOT NULL DEFAULT 0 CHECK (needs_docs IN (0,1)),  -- set by design (S1)

    reason                TEXT,                              -- denormalized last-failure prose (inbox)

    -- Dispatch allocator (monotonic, never resets).
    current_dispatch_seq  INTEGER NOT NULL DEFAULT 0,
    current_dispatch_id   TEXT,                              -- 'ENG-5-d0003'

    -- Linear projection mirror (read-only view of what we last projected).
    linear_state          TEXT,                              -- 'Todo'/'In Progress'/...
    priority              INTEGER,

    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,

    UNIQUE (project_id, ident)
);
CREATE INDEX idx_ticket_ready ON ticket (project_id, status, stage);

-- ============================================================================
-- §B  WORK-UNIT DECOMPOSITION   (C1 — plan splits a ticket into focused units)
-- ============================================================================
CREATE TABLE work_unit (
    id                INTEGER PRIMARY KEY,
    ticket_id         INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,                  -- order within the ticket
    kind              TEXT    NOT NULL,                  -- OPEN vocab from project-profile stack
                                                         -- ('backend'/'frontend'/'data'/'infra'/'test'
                                                         -- /'docs'/...). NOT a CHECK enum (stack-agnostic).
    title             TEXT,
    description       TEXT,

    -- A3 advisory scope (reviewer-judged, NOT a hard gate).
    files_to_touch    TEXT CHECK (files_to_touch IS NULL OR json_valid(files_to_touch)),

    -- A1: behavioral ⇒ test required (deterministic gate at verify).
    behavioral        INTEGER NOT NULL DEFAULT 1 CHECK (behavioral IN (0,1)),
    test_plan         TEXT,

    -- C3: which ground-truth check-types this unit needs (open vocab — matches
    -- ground_truth_signal.signal_type). e.g. ["unit","integration","visual"].
    verify_check_types TEXT CHECK (verify_check_types IS NULL OR json_valid(verify_check_types)),

    depends_on        TEXT CHECK (depends_on IS NULL OR json_valid(depends_on)),  -- [seq,...]; acyclicity
                                                         -- enforced by the runner (S1b), not the schema.
    base_sha          TEXT,                              -- HEAD before the unit's first implement
                                                         -- commit; verify diffs base_sha..HEAD (all
                                                         -- the unit's commits, incl. loopbacks).
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending','implementing','verifying','verified','blocked')),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,

    UNIQUE (ticket_id, seq)
);
CREATE INDEX idx_work_unit_ticket ON work_unit (ticket_id, status);

-- ============================================================================
-- §C  DURABLE EXECUTION   (B1/B3 — the step journal + signals; the core)
-- ============================================================================
CREATE TABLE workflow_step (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    work_unit_id    INTEGER REFERENCES work_unit(id) ON DELETE CASCADE,  -- nullable: ticket-level steps
    seq             INTEGER NOT NULL,                  -- monotonic within the workflow
    step_key        TEXT    NOT NULL,                  -- deterministic name (replay dedup anchor)
    step_type       TEXT    NOT NULL,                  -- 'dispatch'/'verify'/'project'/'await_signal'
                                                       -- /'transition'/'compensate'/...
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','running','succeeded','failed','compensated')),
    attempt         INTEGER NOT NULL DEFAULT 0,        -- retry count at the step layer

    -- B3 exactly-once: side-effecting steps set an idempotency_key. GLOBALLY UNIQUE
    -- BY CONSTRUCTION (prefixed with dispatch_id) → the unique index is the dedup.
    idempotency_key TEXT,

    input_json      TEXT CHECK (input_json  IS NULL OR json_valid(input_json)),
    result_json     TEXT CHECK (result_json IS NULL OR json_valid(result_json)),  -- returned on replay
    error_json      TEXT CHECK (error_json  IS NULL OR json_valid(error_json)),
    pid             INTEGER,                           -- spawned worker PID (recover() orphan-kill)

    await_signal_id INTEGER REFERENCES signal(id),     -- set when step parks on a durable wait
    started_at      TEXT,
    ended_at        TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,

    UNIQUE (ticket_id, step_key)                       -- determinism: one row per logical step
);
CREATE UNIQUE INDEX idx_step_idempotency
    ON workflow_step (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_step_runnable ON workflow_step (ticket_id, status, seq);

-- signal — durable signals / human-waits (B1). Replaces wait-<stage>.json +
-- soft-pending + the build approval gate. Delivered out-of-band (operator action,
-- checks-system poll, the outbox drainer completing pr_create); replay resumes.
CREATE TABLE signal (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    signal_type     TEXT    NOT NULL,                  -- 'human_merge_approval'/'human_plan_approval'
                                                       -- /'human_resume'/'external_checks'/'external_pr_result'
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','delivered','consumed')),
    reason          TEXT,                              -- 'awaiting-approval'/'awaiting-checks'
    -- Wait-budget fields (external_signal_budget).
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER,
    first_attempt_at TEXT,
    last_attempt_at  TEXT,

    payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    idempotency_key TEXT,                              -- dedup duplicate deliveries (globally unique by construction)
    requested_at    TEXT NOT NULL,
    delivered_at    TEXT,
    consumed_at     TEXT
);
CREATE UNIQUE INDEX idx_signal_idempotency
    ON signal (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_signal_pending ON signal (ticket_id, status);

-- ============================================================================
-- §D  DISPATCH RECORDS   (replaces dispatch_history.jsonl + usage-*.json)
-- ============================================================================
-- One row per `claude -p` invocation. Forensic + control. The dispatch step links here.
CREATE TABLE dispatch (
    id                      INTEGER PRIMARY KEY,
    ticket_id               INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    work_unit_id            INTEGER REFERENCES work_unit(id) ON DELETE SET NULL,
    step_id                 INTEGER REFERENCES workflow_step(id) ON DELETE SET NULL,

    dispatch_id             TEXT    NOT NULL,           -- 'ENG-5-d0003'
    seq                     INTEGER NOT NULL,
    predecessor_dispatch_id TEXT,                       -- forensic lineage
    stage                   TEXT,                       -- pipeline stage at dispatch time
    kind                    TEXT,                       -- work-unit kind (NULL for ticket-level)
    model                   TEXT,                       -- resolved model id
    effort                  TEXT,
    trigger                 TEXT,                       -- 'transition'/'retry'/'escalation'/'resume'

    -- Outcome — the slimmed vocabulary (§8 atlas): 'clean-success'/'dispatch-failed'/
    -- 'dispatch-timeout'/'build-red'/'tests-red'/'noop'/'reviewer-blocking'/...
    outcome                 TEXT,
    exit_code               INTEGER,
    exit_subcode            INTEGER,

    -- Provenance snapshot.
    branch                  TEXT,
    branch_head_sha         TEXT,
    worktree_path           TEXT,
    transcript_path         TEXT,

    -- Timing + usage (cost_usd NULL + partial=1 on SIGTERM). Per-ticket spend (P3
    -- budget) = SUM(cost_usd) over a ticket's dispatches.
    started_at              TEXT,
    ended_at                TEXT,
    duration_ms             INTEGER,
    tokens_in               INTEGER,
    tokens_out              INTEGER,
    cache_read              INTEGER,
    cache_create            INTEGER,
    cost_usd                REAL,
    partial                 INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0,1)),

    envelope_json           TEXT CHECK (envelope_json IS NULL OR json_valid(envelope_json)),
    created_at              TEXT NOT NULL,

    UNIQUE (ticket_id, dispatch_id)
);
CREATE INDEX idx_dispatch_ticket ON dispatch (ticket_id, seq);

-- ============================================================================
-- §E  EVENT LOG   (control-decision audit; was pipeline_event — v2 repurpose)
-- ============================================================================
-- Append-only log of what the RUNNER decided: stage transitions, loopbacks (with
-- the failure signature, for distinct-counting + the needs-you trace), escalations,
-- and operator resumes. Verdicts are DERIVED from review_finding (not stored here);
-- transitions are ticket.stage updates mirrored here for the audit trail. Feeds the
-- inbox trace, v_rejection_counts, and (post-cutover) the supervisor.
CREATE TABLE event_log (
    id           INTEGER PRIMARY KEY,
    ticket_id    INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,                      -- monotonic per ticket (ordering)
    kind         TEXT NOT NULL CHECK (kind IN (
                     'transition','loopback','escalated','resumed','note','parked')),
    actor        TEXT CHECK (actor IS NULL OR actor IN ('runner','operator')),
    dispatch_id  TEXT,                                  -- the dispatch this relates to (if any)

    -- transition: from_stage -> to_stage
    from_stage   TEXT,
    to_stage     TEXT,

    -- loopback: which loop, where it routed, the failure signature (P6 distinct-count)
    loop         TEXT,                                  -- 'implement'/'review'/'integration'/'plan'/'rebase'/...
    route_to     TEXT,                                  -- target step/stage
    signature    TEXT,                                  -- the failure signature

    -- escalated / resumed / note
    reason       TEXT,                                  -- escalation reason / resume note

    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    created_at   TEXT NOT NULL,

    UNIQUE (ticket_id, seq)
);
CREATE INDEX idx_event_ticket_kind ON event_log (ticket_id, kind, seq);

-- metric_event — DEFERRED / OPTIONAL analytics denormalization (no writer; NOT an OSS carry).
--   Per-step cost/tokens (incl. cache_read/cache_create) already live on the `dispatch` table and are
--   emitted on the telemetry stream + summed in the run summary; lifecycle events live in `event_log`.
--   This table is just a single-shape rollup a dashboard *could* prefer — the plane derives it from the
--   emitted rows; the OSS core does not write it. Kept as a documented stub. Forensic; NOT control flow.
CREATE TABLE metric_event (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES project(id),
    ticket_id    INTEGER REFERENCES ticket(id) ON DELETE SET NULL,
    ts           TEXT NOT NULL,
    event        TEXT NOT NULL,                         -- 'step-start'/'step-end'/'escalation'/...
    stage        TEXT,
    outcome      TEXT,
    duration_ms  INTEGER,
    dispatch_id  TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    cache_read   INTEGER,
    cache_create INTEGER,
    cost_usd     REAL,
    model        TEXT,
    notes        TEXT
);
CREATE INDEX idx_metric_ts ON metric_event (project_id, ts);

-- ============================================================================
-- §F  GROUND-TRUTH VERIFICATION   (A1/A2 — move 5; replaces self-report grading)
-- ============================================================================
CREATE TABLE ground_truth_signal (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    work_unit_id    INTEGER REFERENCES work_unit(id) ON DELETE CASCADE,
    dispatch_id     TEXT,                               -- the verify dispatch (NULL for runner command runs)
    signal_type     TEXT NOT NULL,                      -- the declared CHECK-TYPE run (open vocab, matches
                                                        -- work_unit.verify_check_types): 'build'/'test'/'unit'
                                                        -- /'integration'/'visual'/'scope_diff'/'ci'/...
    result          TEXT NOT NULL CHECK (result IN ('pass','fail','error')),
    is_authoritative INTEGER NOT NULL DEFAULT 0 CHECK (is_authoritative IN (0,1)),  -- CI = merge arbiter
    branch_head_sha TEXT,                               -- the commit fingerprint this check ran against (M4b-a)
    command         TEXT,                               -- project-profile command run (A1/F4)
    detail_json     TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
                                                        -- {tests_passed,tests_failed,failing:[…]}
                                                        -- / {paths:[…]} / {check_name,url,conclusion}
    measured_at     TEXT NOT NULL
);
CREATE INDEX idx_gts_ticket ON ground_truth_signal (ticket_id, signal_type, measured_at);

-- review_finding — the cold reviewer's output (A2), realigned to the new review
-- model (v2): the reviewer FILES findings via the validated tool interface; the
-- runner computes `blocks_ship`. Covers BOTH the plan review (S1c) and the code
-- review (S5), distinguished by `review_kind`. First-class (the loop iterates
-- over open blocking findings; V6 counts persistence by `finding_class_key`).
CREATE TABLE review_finding (
    id                 INTEGER PRIMARY KEY,
    ticket_id          INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    work_unit_id       INTEGER REFERENCES work_unit(id) ON DELETE CASCADE,  -- NULL for plan/ticket-level
    dispatch_id        TEXT,                            -- the review dispatch
    review_kind        TEXT NOT NULL CHECK (review_kind IN ('plan','code')),  -- S1c vs S5
    finding_class_key  TEXT,                            -- '<dimension>:<scope-anchor>:<concept>' (V6 persistence)
    severity           TEXT NOT NULL CHECK (severity IN ('critical','major','minor','nit')),  -- reviewer-filed
    category           TEXT,                            -- correctness|security|perf|maintainability
                                                        -- |test-quality|scope|plan-defect|… (routes the loopback)
    factors_json       TEXT CHECK (factors_json IS NULL OR json_valid(factors_json)),
                                                        -- {in_changed_code,is_regression,user_visible,
                                                        --  reversible_post_ship,has_workaround}
    deferral_candidate INTEGER NOT NULL DEFAULT 0 CHECK (deferral_candidate IN (0,1)),  -- reviewer-flagged
    blocks_ship        INTEGER CHECK (blocks_ship IN (0,1)),  -- RUNNER-computed (critical-floor + major-not-deferred)
    location           TEXT,                            -- file:line
    rationale          TEXT,
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','deferred','wont-fix')),
    created_at         TEXT NOT NULL,
    -- critical-floor guard (defense-in-depth; the runner also enforces it):
    CHECK (blocks_ship IS NULL OR severity <> 'critical' OR blocks_ship = 1)
);
CREATE INDEX idx_finding_open ON review_finding (ticket_id, status, blocks_ship);

-- ============================================================================
-- §G  LINEAR / GITHUB PROJECTION   (move 2 / §9.4 #4 — one-way, idempotent)
-- ============================================================================

-- linear_id_cache — the linear-ids.json cache, in the SoT for the projector.
CREATE TABLE linear_id_cache (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('team','project','state','label')),
    name        TEXT NOT NULL,                          -- 'Todo' / 'stage:implement' / 'Bug'
    uuid        TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    UNIQUE (project_id, entity_type, name)
);

-- projection_state — current projected snapshot per ticket per target (dedup).
CREATE TABLE projection_state (
    id                     INTEGER PRIMARY KEY,
    ticket_id              INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    target                 TEXT NOT NULL CHECK (target IN ('issue_tracker','forge')),
    projected_stage_label  TEXT,                        -- last 'stage:*' set
    projected_status_labels_json TEXT CHECK (projected_status_labels_json IS NULL
                                             OR json_valid(projected_status_labels_json)),
    projected_linear_state TEXT,                        -- 'In Progress'/...
    last_projected_at      TEXT,
    UNIQUE (ticket_id, target)
);

-- projection_outbox — transactional outbox (CL-2). A SoT write + its outbox row
-- commit in the SAME transaction; the projector drains pending rows idempotently
-- (idempotency_key, globally unique by construction) and marks sent. Crash-safe (B3).
CREATE TABLE projection_outbox (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    target          TEXT NOT NULL CHECK (target IN ('issue_tracker','forge')),
    op              TEXT NOT NULL,                       -- 'set_labels'/'add_comment'/'set_state'
                                                         -- /'push'/'pr_create'/'pr_merge'/...
    payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    idempotency_key TEXT NOT NULL UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','sent','failed','skipped')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    response_ref    TEXT,                                -- Linear comment id / PR url (delivered to a signal)
    error           TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE INDEX idx_outbox_pending ON projection_outbox (status, created_at);

-- ============================================================================
-- §H  DERIVED VIEWS  (derived, not stored)
-- ============================================================================

-- Loopback counts per loop since the last operator resume — the per-loop counter
-- (§8.2). Rebuilt on event_log (v2): count `loopback` events per `loop` since the
-- most recent `resumed`. (B2's cross-loop budget = COUNT over all loops; B3 = spend/time.)
CREATE VIEW v_rejection_counts AS
SELECT
    e.ticket_id,
    e.loop,
    COUNT(*) AS loopbacks_since_resume
FROM event_log e
WHERE e.kind = 'loopback'
  AND e.seq > COALESCE((
        SELECT MAX(r.seq) FROM event_log r
        WHERE r.ticket_id = e.ticket_id AND r.kind = 'resumed'), 0)
GROUP BY e.ticket_id, e.loop;

-- Tickets the runner may pick this tick (active, project not paused, not parked).
CREATE VIEW v_ready_tickets AS
SELECT t.*
FROM ticket t
JOIN project p ON p.id = t.project_id
WHERE p.paused = 0
  AND t.status = 'active'
  AND NOT EXISTS (
        SELECT 1 FROM signal s
        WHERE s.ticket_id = t.id AND s.status = 'pending');

-- ============================================================================
-- §X  DEFERRED — UGL / SUPERVISOR / MEMORY (post-cutover I-C/I-D; §5.8, E1/E2)
-- ----------------------------------------------------------------------------
-- NOT created at cutover. Forward-compatibility sketch only. E2 (decision_class /
-- action_surface vocabularies) is still OPEN — the CHECK enums below are placeholders.
--
-- CREATE TABLE memory_record (              -- §5.8.5 index keys
--     id                 INTEGER PRIMARY KEY,
--     scope_level        TEXT CHECK (scope_level IN ('global','project','ticket-class','code-area','ticket')),
--     project_id         INTEGER REFERENCES project(id),
--     ticket_id          INTEGER REFERENCES ticket(id),     -- only for scope_level='ticket'
--     stage              TEXT,
--     decision_class     TEXT,    -- [E2 OPEN]
--     action_surface     TEXT,    -- [E2 OPEN]
--     code_locus         TEXT,
--     provenance         TEXT CHECK (provenance IN ('human','retro','supervisor')),  -- human > retro > supervisor
--     outcome            TEXT CHECK (outcome IN ('resolved','recurred','unknown')),
--     confidence         REAL,
--     context_fingerprint TEXT,
--     supersedes         INTEGER REFERENCES memory_record(id),
--     situation          TEXT, decision TEXT, action TEXT, rationale TEXT,  -- model-written
--     embedding          BLOB,    -- E1: brute-force cosine -> sqlite-vec when it grows
--     created_at         TEXT NOT NULL, last_confirmed_at TEXT
-- );
-- The review-deferral decisions recorded now (CL-NODEFER: record-now/learn-later)
-- seed this table; at cutover they live as `event_log` escalation+resume rows.
-- ============================================================================
