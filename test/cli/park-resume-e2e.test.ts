import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parkDir } from "../../src/cli/park.ts";
import { runParkedTicket } from "../helpers/run-harness.ts";

test("a parked run writes run.db + transcript.json under the state dir and reports cause", async () => {
  // runParkedTicket: sets XDG_STATE_HOME to a temp dir, drives ENG-1 with a session-limit FakeRunner
  // via the same wiring as src/cli/run.ts, and returns { slug, ident, park, exitCode }.
  const { slug, ident, exitCode } = await runParkedTicket();
  const dir = parkDir(slug, ident);
  expect(existsSync(join(dir, "run.db"))).toBe(true);
  expect(existsSync(join(dir, "transcript.json"))).toBe(true);
  expect(exitCode).toBe(75);
});
