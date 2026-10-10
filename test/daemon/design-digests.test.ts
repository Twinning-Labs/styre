import { expect, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_PLAN_DIGEST,
  digestWorkUnits,
  planDigestAt,
  ticketPlanFilesAt,
} from "../../src/daemon/design-digests.ts";
import { insertTicket, setNeedsDocs } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setBaseSha, setStatus } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../helpers/db.ts";
import { STEP_TEST_TIMEOUT_MS, git, gitRepo } from "../helpers/design-steps.ts";

const plan = (ident: string, body: string) => `---\nlinear: ${ident}\n---\n\n${body}\n`;
function commitAll(repo: string, msg: string) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg]);
}

test(
  "a renamed plan changes the digest; another ticket's plan and a nested file do not",
  () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "docs", "plans", "sub"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "body"));
    commitAll(repo, "plan a");
    const first = planDigestAt(repo, "main", "ENG-1");
    renameSync(join(repo, "docs", "plans", "a.md"), join(repo, "docs", "plans", "b.md"));
    commitAll(repo, "rename");
    const renamed = planDigestAt(repo, "main", "ENG-1");
    expect(renamed).not.toBe(first);
    writeFileSync(join(repo, "docs", "plans", "other.md"), plan("ENG-9", "another ticket"));
    writeFileSync(join(repo, "docs", "plans", "sub", "x.md"), plan("ENG-1", "nested"));
    commitAll(repo, "unrelated");
    expect(planDigestAt(repo, "main", "ENG-1")).toBe(renamed);
    writeFileSync(join(repo, "docs", "plans", "b.md"), plan("ENG-1", "edited body"));
    commitAll(repo, "edit");
    expect(planDigestAt(repo, "main", "ENG-1")).not.toBe(renamed);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the plan digest reads git at the ref, never the working tree",
  () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "committed"));
    commitAll(repo, "plan");
    const committed = planDigestAt(repo, "main", "ENG-1");
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "uncommitted edit"));
    expect(planDigestAt(repo, "main", "ENG-1")).toBe(committed);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a missing ref fails loudly",
  () => {
    expect(() => planDigestAt(gitRepo(), "feat/never", "ENG-1")).toThrow("git ls-tree");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the units digest ignores ids, status, base_sha and reconcile units, and covers needs_docs",
  () => {
    const { db, projectId } = makeTestDb();
    const a = insertTicket(db, { projectId, ident: "ENG-10" });
    const b = insertTicket(db, { projectId, ident: "ENG-11" });
    const unit = (ticketId: number) =>
      insertWorkUnit(db, {
        ticketId,
        seq: 1,
        kind: "backend",
        title: "t",
        description: "d",
        behavioral: 0,
        filesToTouch: ["a.ts"],
        verifyCheckTypes: [],
        dependsOn: [],
      });
    const ua = unit(a);
    unit(b); // a different id
    expect(digestWorkUnits(db, a)).toBe(digestWorkUnits(db, b));
    setStatus(db, ua.id, "verified");
    setBaseSha(db, ua.id, "abc");
    insertWorkUnit(db, {
      ticketId: a,
      seq: 2,
      kind: "reconcile",
      origin: "reconcile",
      dependsOn: [1],
    });
    expect(digestWorkUnits(db, a)).toBe(digestWorkUnits(db, b));
    setNeedsDocs(db, a, 1);
    expect(digestWorkUnits(db, a)).not.toBe(digestWorkUnits(db, b));
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a plan is this ticket's only by its frontmatter linear: value, exactly; only docs/plans/*.md count",
  () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    // ENG-10 starts with ENG-1; ENG-2's plan names ENG-1 only in its body; notes.txt is not markdown
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-10", "another ticket"));
    writeFileSync(join(repo, "docs", "plans", "b.md"), plan("ENG-2", "linear: ENG-1"));
    writeFileSync(join(repo, "docs", "plans", "notes.txt"), plan("ENG-1", "not a plan file"));
    commitAll(repo, "other plans");
    expect(ticketPlanFilesAt(repo, "main", "ENG-1")).toEqual([]);
    expect(planDigestAt(repo, "main", "ENG-1")).toBe(EMPTY_PLAN_DIGEST);
    writeFileSync(join(repo, "docs", "plans", "c.md"), plan("ENG-1", "the plan"));
    commitAll(repo, "the plan");
    expect(ticketPlanFilesAt(repo, "main", "ENG-1")).toEqual([
      { path: "docs/plans/c.md", content: plan("ENG-1", "the plan") },
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the units digest follows seq, not the order the units were written in",
  () => {
    const { db, projectId } = makeTestDb();
    const a = insertTicket(db, { projectId, ident: "ENG-10" });
    const b = insertTicket(db, { projectId, ident: "ENG-11" });
    const unit = (ticketId: number, seq: number) =>
      insertWorkUnit(db, {
        ticketId,
        seq,
        kind: "backend",
        title: `t${seq}`,
        description: "d",
        behavioral: 0,
        filesToTouch: [`f${seq}.ts`],
        verifyCheckTypes: [],
        dependsOn: [],
      });
    unit(a, 1);
    unit(a, 2);
    unit(b, 2); // written first, still second by seq
    unit(b, 1);
    expect(digestWorkUnits(db, a)).toBe(digestWorkUnits(db, b));
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);
