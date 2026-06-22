import { expect, test } from "bun:test";
import { insertProject } from "../../src/db/repos/project.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";

test("insertTicket persists ingestion fields incl. description", () => {
  const { db } = makeTestDb();
  const projectId = insertProject(db, { slug: "demo", targetRepo: "/tmp/x" });
  const id = insertTicket(db, {
    projectId,
    ident: "ENG-9",
    title: "Add a thing",
    description: "## Context\nDo the thing.",
    typeLabel: "Bug",
    branchPrefix: "fix",
    linearIssueUuid: "uuid-123",
  });
  const t = getTicket(db, id);
  expect(t?.title).toBe("Add a thing");
  expect(t?.description).toBe("## Context\nDo the thing.");
  expect(t?.type_label).toBe("Bug");
  expect(t?.branch_prefix).toBe("fix");
  db.close();
});
