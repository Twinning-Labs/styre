import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { claudeAgentRunner } from "../agent/providers/claude.ts";
import { selectAgentRunner } from "../agent/registry.ts";
import { DEFAULT_AGENT_CONFIG } from "../config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../config/runtime-config.ts";
import { makeProjectorPorts } from "../daemon/ports.ts";
import { realRecoverDeps, recover } from "../daemon/recover.ts";
import { runTicket } from "../daemon/run-ticket.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { buildDispatchRegistry } from "../dispatch/handlers.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { stdoutSink } from "../telemetry/emit.ts";
import { dumpPark } from "./park.ts";

export const runCommand = defineCommand({
  meta: { name: "run", description: "Ingest one ticket and drive it to PR-ready, then exit." },
  args: {
    ticket: { type: "positional", required: true, description: "Ticket ref (e.g. ENG-123)" },
    profile: { type: "string", required: true, description: "Path to the project-profile JSON" },
    config: { type: "string", description: "Path to a runtime config.json (optional)" },
    db: { type: "string", description: "DB path (default: a fresh per-run temp DB)" },
  },
  async run({ args }) {
    const dbPath =
      args.db && args.db.length > 0
        ? args.db
        : join(mkdtempSync(join(tmpdir(), "styre-run-")), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    recover(db, realRecoverDeps());

    const profile = loadProfile(args.profile);
    const runtimeConfig =
      args.config && args.config.length > 0
        ? RuntimeConfigSchema.parse(JSON.parse(readFileSync(args.config, "utf8")))
        : DEFAULT_RUNTIME_CONFIG;

    const ports = makeProjectorPorts(runtimeConfig, profile);
    const runner = selectAgentRunner(DEFAULT_AGENT_CONFIG, { claude: () => claudeAgentRunner() });
    const registry = buildDispatchRegistry({
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile,
      worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
    });

    const out = await runTicket({
      db,
      profile,
      runtimeConfig,
      ports,
      registry,
      ticketRef: args.ticket,
      emit: stdoutSink,
    });
    console.error(out.summary); // human summary → stderr; stdout carries only NDJSON telemetry
    if (out.outcome === "parked" && out.park) {
      const ident = getTicket(db, out.ticketId)?.ident ?? args.ticket;
      const dir = dumpPark(db, dbPath, profile.slug, ident, out.park); // dumpPark closes db
      console.error(
        `Parked: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
          `Resume with: styre run --resume ${ident} --profile ${args.profile}\n` +
          `Dump: ${dir}`,
      );
      process.exitCode = 75;
      return;
    }
    db.close();
    if (out.outcome === "blocked" || out.outcome === "no-progress") {
      throw new Error(`run: ticket ${args.ticket} ended ${out.outcome}`);
    }
  },
});
