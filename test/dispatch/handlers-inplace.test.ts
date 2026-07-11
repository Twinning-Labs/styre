import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { type RegistryDeps, worktreeFor } from "../../src/dispatch/handlers.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Build a real HandlerContext against a seeded ticket, with `project.target_repo` overridden
 *  and the ticket's ident set — the resolution reads only these two fields. */
function seedCtx(opts: { targetRepo: string; ident: string }): { ctx: HandlerContext } {
  const { db, ticketId, projectId } = makeTestDb();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(opts.targetRepo, projectId);
  db.query("UPDATE ticket SET ident = ? WHERE id = ?").run(opts.ident, ticketId);
  const step = insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { ctx: { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG } };
}

test("worktreeFor: inPlace resolves worktreePath to repoPath", () => {
  const { ctx } = seedCtx({ targetRepo: "/some/repo", ident: "ENG-1" });
  const wt = worktreeFor(ctx, {
    inPlace: true,
    worktreeRoot: "/tmp/x",
  } as unknown as RegistryDeps);
  expect(wt.worktreePath).toBe("/some/repo");
  expect(wt.repoPath).toBe("/some/repo");
});

test("worktreeFor: default (worktree) resolves under worktreeRoot", () => {
  const { ctx } = seedCtx({ targetRepo: "/some/repo", ident: "ENG-1" });
  const wt = worktreeFor(ctx, {
    inPlace: false,
    worktreeRoot: "/tmp/x",
  } as unknown as RegistryDeps);
  expect(wt.worktreePath).toBe("/tmp/x/ENG-1");
});
