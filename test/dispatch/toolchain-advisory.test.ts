import { expect, test } from "bun:test";
import type { UnusableComponent } from "../../src/cli/preflight.ts";
import { listByTicket } from "../../src/db/repos/ground-truth-signal.ts";
import { recordUnusableComponents } from "../../src/dispatch/provision.ts";
import { makeTestDb } from "../helpers/db.ts";

const unusable = (component: string, ...tools: string[]): UnusableComponent => ({
  component,
  missing: tools.map((t) => ({ component, label: "build", command: `${t} build`, missing: t })),
});

const advisories = (db: ReturnType<typeof makeTestDb>["db"], ticketId: number) =>
  listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "toolchain")
    .map((s) => JSON.parse(s.detail_json ?? "{}") as { components: string[] });

test("the toolchain advisory is recorded once per list: the same list again adds no row", () => {
  const { db, ticketId } = makeTestDb();
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build")]);
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build")]);
  expect(advisories(db, ticketId).map((a) => a.components)).toEqual([["lib"]]);
  db.close();
});

test("a different list records a second advisory", () => {
  const { db, ticketId } = makeTestDb();
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build")]);
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build"), unusable("web", "node")]);
  // the same components with other missing tools is another list too
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-test"), unusable("web", "node")]);
  expect(advisories(db, ticketId).map((a) => a.components)).toEqual([
    ["lib"],
    ["lib", "web"],
    ["lib", "web"],
  ]);
  db.close();
});

test("list order does not matter: the same components in another order add no row", () => {
  const { db, ticketId } = makeTestDb();
  recordUnusableComponents(db, ticketId, [unusable("web", "node"), unusable("lib", "a", "b")]);
  recordUnusableComponents(db, ticketId, [unusable("lib", "b", "a"), unusable("web", "node")]);
  expect(advisories(db, ticketId)).toHaveLength(1);
  db.close();
});

test("only the newest advisory counts: a list recorded before another is recorded again", () => {
  const { db, ticketId } = makeTestDb();
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build")]);
  recordUnusableComponents(db, ticketId, [unusable("web", "node")]);
  recordUnusableComponents(db, ticketId, [unusable("lib", "lib-build")]);
  expect(advisories(db, ticketId).map((a) => a.components)).toEqual([["lib"], ["web"], ["lib"]]);
  db.close();
});

test("an empty list records nothing", () => {
  const { db, ticketId } = makeTestDb();
  recordUnusableComponents(db, ticketId, []);
  expect(advisories(db, ticketId)).toEqual([]);
  db.close();
});
