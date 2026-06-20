import { expect, test } from "bun:test";
import { getProject } from "../../../src/db/repos/project.ts";
import { getTicket, setTicketStatus } from "../../../src/db/repos/ticket.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("makeTestDb seeds a project and ticket", () => {
  const { db, projectId, ticketId } = makeTestDb();
  const project = getProject(db, projectId);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(project?.slug).toBe("test-project");
  expect(ticket?.project_id).toBe(projectId);
  expect(ticket?.stage).toBe("design");
  expect(ticket?.status).toBe("active");
});

test("setTicketStatus updates the ticket disposition", () => {
  const { db, ticketId } = makeTestDb();
  setTicketStatus(db, ticketId, "waiting");
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.status).toBe("waiting");
});

test("nowUtc returns a Zulu ISO-8601 timestamp", async () => {
  const { nowUtc } = await import("../../../src/util/time.ts");
  expect(nowUtc()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
