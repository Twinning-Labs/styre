import type { Database } from "bun:sqlite";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { z } from "zod";
import { listByTicket } from "../db/repos/ground-truth-signal.ts";
import type { ReviewEvidenceSchema } from "./review-schema.ts";

/** Verify citation existence/provenance, not its semantic truth. That remains the independent reviewer's job. */
export function validateReviewEvidence(
  db: Database,
  ticketId: number,
  root: string,
  sha: string,
  evidence: z.infer<typeof ReviewEvidenceSchema>[],
  committed = false,
): void {
  const signals = listByTicket(db, ticketId);
  for (const e of evidence) {
    if (e.kind === "source") {
      if (isAbsolute(e.path)) throw new Error("review evidence paths must be repository-relative");
      const realRoot = realpathSync(root);
      const target = realpathSync(resolve(root, e.path));
      const rel = relative(realRoot, target);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !statSync(target).isFile())
        throw new Error("review evidence path escapes repository or is not a file");
      let source = readFileSync(target, "utf8");
      if (committed) {
        const blob = Bun.spawnSync(["git", "show", `${sha}:${rel}`], { cwd: root });
        if (!blob.success)
          throw new Error("review source evidence is absent from the recorded commit");
        source = blob.stdout.toString();
      }
      if (e.line > source.split("\n").length)
        throw new Error("review evidence cites a nonexistent source line");
    } else if (e.kind === "measurement") {
      const signal = signals.find((s) => s.id === e.signal_id);
      if (!signal || signal.branch_head_sha !== sha)
        throw new Error("review evidence measurement is foreign, missing, or stale");
    } else {
      if (!["https:", "http:"].includes(new URL(e.url).protocol))
        throw new Error("review reference must be an HTTP(S) source");
    }
  }
}
