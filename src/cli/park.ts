import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../config/paths.ts";
import type { ParkInfo } from "../engine/park-signal.ts";

/**
 * Handle the terminal result of a `styre run` after `runTicket`/`driveToTerminal` returns.
 * Mirrors the inline tail of `src/cli/run.ts` so the same code path is exercised in tests.
 *
 * - parked: calls `dumpPark` (which closes db), sets `process.exitCode = 75`, returns.
 * - blocked | no-progress: closes db, throws.
 * - otherwise (pr-ready): closes db, returns.
 *
 * The human-readable resume-hint line (`Resume with: styre run --resume …`) is intentionally
 * left in `run.ts` because it requires `args.profile` which we don't want to thread here.
 */
export function finishRunResult(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  out: { outcome: string; park?: ParkInfo },
): void {
  if (out.outcome === "parked" && out.park) {
    dumpPark(db, dbPath, slug, ident, out.park); // closes db
    process.exitCode = 75;
    return;
  }
  db.close();
  if (out.outcome === "blocked" || out.outcome === "no-progress") {
    throw new Error(`run: ticket ${ident} ended ${out.outcome}`);
  }
}

/** The durable dump dir for a parked run: ~/.local/state/styre/<project-stub>/<ticket-ident>/ */
export function parkDir(slug: string, ident: string): string {
  return join(stateDir(), slug, ident);
}

/** Persist the parked run so `styre run --resume` can rehydrate it exactly:
 *   - run.db: the SoT (checkpointed so the single file is self-contained), with the interrupted
 *     step left 'running' (recover() resets it on resume)
 *   - transcript.json: the dying dispatch's partial stdout, for advisory carryover
 *  The branch commits are already durable in the target repo's git. Returns the dump dir.
 *  NOTE: the caller must NOT have closed `db` yet — this checkpoints then the caller closes. */
export function dumpPark(
  db: Database,
  dbPath: string,
  slug: string,
  ident: string,
  park: ParkInfo,
): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold WAL into the main file before copy
  db.close();
  copyFileSync(dbPath, join(dir, "run.db"));
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      dispatchId: park.dispatchId,
      cause: park.cause,
      resetAt: park.resetAt,
      transcript: park.transcript,
    }),
  );
  return dir;
}
