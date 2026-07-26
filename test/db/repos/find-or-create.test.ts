import { expect, test } from "bun:test";
import { getBySlug, insertProject } from "../../../src/db/repos/project.ts";
import { getByIdent, insertTicket } from "../../../src/db/repos/ticket.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertProject is find-or-create: a second insert with the same slug returns the same id", () => {
  const { db, projectId } = makeTestDb();
  const again = insertProject(db, { slug: "test-project", targetRepo: "/tmp/other" });
  expect(again).toBe(projectId); // existing id, not a new row / not 0
  expect(getBySlug(db, "test-project")?.id).toBe(projectId);
  // No update on conflict: the ORIGINAL target_repo ("/tmp/repo", seeded by makeTestDb) survives —
  // the conflicting insert's "/tmp/other" is discarded, not applied.
  expect(getBySlug(db, "test-project")?.target_repo).toBe("/tmp/repo");
  expect(getBySlug(db, "absent")).toBeNull();
  db.close();
});

test("insertTicket is find-or-create on (project_id, ident): same ident returns the same id", () => {
  const { db, projectId, ticketId } = makeTestDb();
  const again = insertTicket(db, { projectId, ident: "ENG-1", title: "changed" });
  expect(again).toBe(ticketId);
  expect(getByIdent(db, projectId, "ENG-1")?.id).toBe(ticketId);
  // No update on conflict: the ORIGINAL title (null, seeded by makeTestDb with no title given)
  // survives — the conflicting insert's "changed" is discarded, not applied.
  expect(getByIdent(db, projectId, "ENG-1")?.title).toBeNull();
  expect(getByIdent(db, projectId, "ENG-2")).toBeNull();
  db.close();
});
