import { expect, test } from "bun:test";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { resetProvisionIfManifestTouched } from "../../src/dispatch/provision.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a manifest-touching diff re-arms a hoisted, already-done provision (no redundant re-provision otherwise)", async () => {
  const { db, ticketId } = makeTestDb();
  // Hoisted provision already succeeded at design-HEAD.
  await runStep(db, {
    ticketId,
    stepKey: "provision",
    stepType: "provision",
    execute: () => ({ provisioned: 0 }),
  });
  expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");

  // A non-manifest implement diff leaves provision done (no redundant re-provision).
  resetProvisionIfManifestTouched(db, ticketId, ["src/api.py"]);
  expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");

  // A dependency-manifest diff re-arms it (resetProvision flips succeeded→pending) → the resolver's
  // implement provision gate will re-run.
  resetProvisionIfManifestTouched(db, ticketId, ["pyproject.toml"]);
  expect(getByKey(db, ticketId, "provision")?.status).toBe("pending");
  db.close();
});
