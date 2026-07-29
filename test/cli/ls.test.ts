import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lsImpl } from "../../src/cli/ls.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { seedCheckpoint } from "../helpers/checkpoint.ts";

describe("lsImpl", () => {
  test("lists a needs_you effort with its resume hint", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-ls-"));
    const written: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      seedCheckpoint(root, "proj", "ENG-1", (db, id) => {
        setTicketStatus(db, id, "waiting");
        insertPending(db, {
          ticketId: id,
          signalType: "human_resume",
          reason: "needs you: composer not installed",
        });
      });

      await lsImpl({ root });

      const out = written.join("");
      expect(out).toContain("ENG-1");
      expect(out).toContain("needs you: composer not installed");
      expect(out).toContain("styre run --resume ENG-1 --slug proj");
    } finally {
      process.stdout.write = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("qualifies finished leftovers with their project slug", async () => {
    const root = mkdtempSync(join(tmpdir(), "styre-ls-"));
    const written: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => {
      written.push(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      seedCheckpoint(root, "proj-a", "ENG-10", (db, id) => setTicketStatus(db, id, "done"));
      seedCheckpoint(root, "proj-b", "ENG-20", (db, id) => {
        setTicketStage(db, id, "merge");
        insertPending(db, { ticketId: id, signalType: "human_merge_approval" });
      });

      await lsImpl({ root });

      const out = written.join("");
      expect(out).toContain("proj-a/ENG-10");
      expect(out).toContain("proj-b/ENG-20");
      expect(out).toContain("reap per project");
    } finally {
      process.stdout.write = orig;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
