import type { Database } from "bun:sqlite";

/** One forbidden UPDATE per CHECK constraint. Pragmas do not expose CHECKs (spec §7.3), so the
 *  migrated and the fresh database must both reject each of these. `where` picks the seeded row. */
export interface CheckProbe {
  table: string;
  set: string;
  where: string;
}

/** Valid rows, in foreign key order, that exist on every shape from v7 on. Ids 900 avoid fixture rows. */
export const SEED_ROWS_V8: string[] = [
  "INSERT INTO project (id, slug, target_repo, created_at, updated_at) VALUES (900, 'probe', '/x', 't', 't')",
  "INSERT INTO ticket (id, project_id, ident, stage, created_at, updated_at) VALUES (900, 900, 'P-1', 'design', 't', 't')",
  "INSERT INTO work_unit (id, ticket_id, seq, kind, created_at, updated_at) VALUES (900, 900, 1, 'backend', 't', 't')",
  "INSERT INTO signal (id, ticket_id, signal_type, requested_at) VALUES (900, 900, 'x', 't')",
  "INSERT INTO workflow_step (id, ticket_id, seq, step_key, step_type, created_at, updated_at) VALUES (900, 900, 1, 'probe', 'dispatch', 't', 't')",
  "INSERT INTO dispatch (id, ticket_id, dispatch_id, seq, created_at) VALUES (900, 900, 'P-1-d0001', 1, 't')",
  "INSERT INTO event_log (id, ticket_id, seq, kind, created_at) VALUES (900, 900, 1, 'note', 't')",
  "INSERT INTO ground_truth_signal (id, ticket_id, signal_type, result, measured_at) VALUES (900, 900, 'x', 'pass', 't')",
  "INSERT INTO review_finding (id, ticket_id, review_kind, severity, created_at) VALUES (900, 900, 'plan', 'minor', 't')",
  "INSERT INTO acceptance_criterion (id, ticket_id, seq, text, source, created_at, updated_at) VALUES (900, 900, 1, 'x', 'checklist', 't', 't')",
  "INSERT INTO ac_check (id, ticket_id, ac_id, selector, created_at, updated_at) VALUES (900, 900, 900, 's', 't', 't')",
  "INSERT INTO external_id_cache (id, project_id, entity_type, name, uuid, refreshed_at) VALUES (900, 900, 'team', 'n', 'u', 't')",
  "INSERT INTO projection_state (id, ticket_id, target) VALUES (900, 900, 'forge')",
  "INSERT INTO projection_outbox (id, ticket_id, target, op, idempotency_key, created_at) VALUES (900, 900, 'forge', 'push', 'probe-1', 't')",
  "INSERT INTO run (id, run_id, started_at, provider) VALUES (900, 'r', 't', 'claude')",
];

const p = (table: string, set: string): CheckProbe => ({ table, set, where: "id = 900" });

/** Every CHECK in the v8 schema.sql (47; the three in the commented memory_record stub excluded). */
export const CHECK_PROBES_V8: CheckProbe[] = [
  p("project", "config_json = 'not json'"),
  p("project", "checks_system = 'svn'"),
  p("project", "checks_config_json = 'not json'"),
  p("project", "paused = 2"),
  p("ticket", "type_label = 'Chore'"),
  p("ticket", "branch_prefix = 'chore'"),
  p("ticket", "stage = 'building'"),
  p("ticket", "status = 'halted'"),
  p("ticket", "track = 'slow'"),
  p("ticket", "needs_docs = 2"),
  p("work_unit", "files_to_touch = 'x'"),
  p("work_unit", "behavioral = 2"),
  p("work_unit", "verify_check_types = 'x'"),
  p("work_unit", "depends_on = 'x'"),
  p("work_unit", "status = 'done'"),
  p("workflow_step", "status = 'done'"),
  p("workflow_step", "input_json = 'x'"),
  p("workflow_step", "result_json = 'x'"),
  p("workflow_step", "error_json = 'x'"),
  p("signal", "status = 'lost'"),
  p("signal", "payload_json = 'x'"),
  p("dispatch", "partial = 2"),
  p("dispatch", "envelope_json = 'x'"),
  p("event_log", "kind = 'other'"),
  p("event_log", "actor = 'daemon'"),
  p("event_log", "payload_json = 'x'"),
  p("ground_truth_signal", "result = 'maybe'"),
  p("ground_truth_signal", "is_authoritative = 2"),
  p("ground_truth_signal", "detail_json = 'x'"),
  p("review_finding", "review_kind = 'docs'"),
  p("review_finding", "severity = 'blocker'"),
  p("review_finding", "factors_json = 'x'"),
  p("review_finding", "deferral_candidate = 2"),
  p("review_finding", "blocks_ship = 2"),
  p("review_finding", "status = 'closed'"),
  p("review_finding", "severity = 'critical', blocks_ship = 0"),
  p("acceptance_criterion", "source = 'ticket'"),
  p("ac_check", "red_first_result = 'blue'"),
  p("ac_check", "red_class = 'x'"),
  p("ac_check", "disposition = 'x'"),
  p("external_id_cache", "entity_type = 'user'"),
  p("projection_state", "target = 'slack'"),
  p("projection_state", "projected_status_labels_json = 'x'"),
  p("projection_outbox", "target = 'slack'"),
  p("projection_outbox", "payload_json = 'x'"),
  p("projection_outbox", "status = 'lost'"),
  p("run", "resumed = 2"),
];

/** Seed inside a savepoint, try each forbidden update, roll everything back. Returns the probes the
 *  database ACCEPTED (an empty list means every CHECK held). */
export function probeChecks(
  db: Database,
  seeds: readonly string[],
  probes: readonly CheckProbe[],
): string[] {
  const accepted: string[] = [];
  db.exec("SAVEPOINT probe_checks");
  try {
    for (const s of seeds) db.exec(s);
    for (const probe of probes) {
      db.exec("SAVEPOINT one_probe");
      try {
        db.exec(`UPDATE ${probe.table} SET ${probe.set} WHERE ${probe.where}`);
        accepted.push(`${probe.table}: ${probe.set}`);
      } catch (err) {
        if (!/CHECK constraint failed/.test(String(err))) throw err;
      } finally {
        db.exec("ROLLBACK TO one_probe");
        db.exec("RELEASE one_probe");
      }
    }
  } finally {
    db.exec("ROLLBACK TO probe_checks");
    db.exec("RELEASE probe_checks");
  }
  return accepted;
}

export const SEED_ROWS_V9: string[] = [
  ...SEED_ROWS_V8,
  "INSERT INTO ticket_input (ticket_id, name, value_json, digest, captured_at) VALUES (900, 'probe', '1', 'd', 't')",
  "INSERT INTO workflow_step_history (id, step_id, ticket_id, event_id, step_key, status, attempt, generation, archived_at) VALUES (900, 900, 900, 900, 'probe', 'succeeded', 1, 0, 't')",
];

/** Every CHECK in the v9 schema.sql (50): v8's 47 and the three 0009 adds. */
export const CHECK_PROBES_V9: CheckProbe[] = [
  ...CHECK_PROBES_V8,
  { table: "workflow_step", set: "input_manifest = 'x'", where: "id = 900" },
  { table: "work_unit", set: "origin = 'manual'", where: "id = 900" },
  { table: "ticket_input", set: "value_json = 'x'", where: "ticket_id = 900 AND name = 'probe'" },
];
