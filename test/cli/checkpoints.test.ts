import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { seedCheckpoint } from "../helpers/checkpoint.ts";

describe("listCheckpoints", () => {
  test("classifies needs_you, pr-ready, done, and crashed→interrupted efforts", () => {
    const root = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
    try {
      seedCheckpoint(root, "proj", "ENG-1", (db, id) => {
        setTicketStatus(db, id, "waiting");
        insertPending(db, {
          ticketId: id,
          signalType: "human_resume",
          reason: "needs you: composer not installed",
        });
      });
      seedCheckpoint(root, "proj", "ENG-2", (db, id) => {
        setTicketStage(db, id, "merge");
        insertPending(db, { ticketId: id, signalType: "human_merge_approval" });
      });
      seedCheckpoint(root, "proj", "ENG-3", (db, id) => setTicketStatus(db, id, "done"));
      seedCheckpoint(root, "proj", "ENG-4", () => {}); // active, no signal, no transcript → interrupted

      const found = listCheckpoints(root);
      const by = (ident: string) => found.find((c) => c.ident === ident);
      expect(by("ENG-1")?.kind).toBe("needs_you");
      expect(by("ENG-1")?.note).toBe("needs you: composer not installed");
      expect(by("ENG-2")?.kind).toBe("pr-ready");
      expect(by("ENG-3")?.kind).toBe("done");
      expect(by("ENG-4")?.kind).toBe("interrupted");
      expect(by("ENG-4")?.resumable).toBe(true);
      expect(found.every((c) => c.live === false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
