import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { FINGERPRINT_SCHEME, digestValue } from "../../src/daemon/canonical.ts";
import { digestTrack, digestWorkUnits, planDigestOf } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { listInputs } from "../../src/db/repos/ticket-input.ts";
import { insertTicket, setNeedsDocs, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

/** The digests of a fixed set of inputs, per FINGERPRINT_SCHEME (operator ruling, 2026-10-09, spec
 *  §5.1). A change to the encoding, to how the profile or config is parsed (a new default included),
 *  to what a table step declares, or to how a snapshot row or an output is digested changes one of
 *  them: paused runs would rerun their design steps although nobody edited anything. That is a
 *  scheme change. Bump FINGERPRINT_SCHEME deliberately and add its pin here; never edit an existing
 *  pin. */
const PINNED: Record<number, Record<string, string>> = {
  1: {
    "declared design:dispatch grading off":
      "42998b5bdce886188e9b098c58b7cbe6ac6f0109accb644fd9682090ec1a7de5",
    "declared design:dispatch grading on":
      "42998b5bdce886188e9b098c58b7cbe6ac6f0109accb644fd9682090ec1a7de5",
    "declared design:extract grading off":
      "b877a5b50c2284fa1dd6fee3152d57444d6b223f263e2af25fe1ad59fd00dc16",
    "declared design:extract grading on":
      "b877a5b50c2284fa1dd6fee3152d57444d6b223f263e2af25fe1ad59fd00dc16",
    "declared design:review grading off":
      "edb73d2312dbfb9317b32a52cd02832855ad8102ad25d0f807048ec1a7f2dbcb",
    "declared design:review grading on":
      "edb73d2312dbfb9317b32a52cd02832855ad8102ad25d0f807048ec1a7f2dbcb",
    "declared design:size grading off":
      "36edc1b2ec2a568f94a1eea4e07aee6c4756bfd24c3aa9f6ea766bf986f9bbfe",
    "declared design:size grading on":
      "1e5d99b9f45381daac2e0aaac3222a1e29f13307f209f31c8c49178c654a8802",
    "declared provision grading off":
      "b7a137a21695c782458c072a786e4f0a6741937dfa7758a15f30e2322e5477f0",
    "declared provision grading on":
      "b7a137a21695c782458c072a786e4f0a6741937dfa7758a15f30e2322e5477f0",
    "output plan": "659f94bab648c7902c9a07fb7dce02dea5f9a97e099e213e630d1cc26c513f0e",
    "output track": "1e5941238a72b1f89a5d4cfad9164d5d37f08fab209161841ebf39bf057083d4",
    "output workUnits": "e49334e5d19993041d22675651698314b80a67aef8083a2470f5c7aa819fb86a",
    "snapshot config.complexityGrading":
      "fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa",
    "snapshot profile.components":
      "0fee9580a091b6a38187687144b8a4dd8bdc26cf765642918c88b661e88b80ad",
    "snapshot profile.promptVars":
      "cac1023609a5943e4b7092ab86c7a8fb5ad34377067e4e64dcfd3c97666a5911",
    "snapshot profile.runtimeContext":
      "c888330e9491b3181782bd06e6555c17d904bfbda3d6f0236a5f4e41a01c50b4",
    "snapshot profile.slug": "36e0b7062f77d8cf22c7146e8b9499479aa8115716d9cd6da81758d1e530fb9d",
    "snapshot run.nonPrimaryComponents":
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "snapshot run.unusableComponents":
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "snapshot ticket.description":
      "2b9a80a9ebce9bde5025c536e837433fb546e4e71a5ef011c9b5e7dfceb5c25b",
    "snapshot ticket.ident": "35dab657a7e807b964d56c1a25e6d39ed0db1ac52809dc295a0fd205f4fa9dcb",
    "snapshot ticket.title": "3165960a9780bb8457cf8b20c74b9de057c512a1b7ea6dfc8e382800e1b441e9",
  },
};

/** Frozen here, never shared with other tests: an edit to a shared helper must not fail the pin. The
 *  second component's test policy pins how an optional object reaches the snapshot (its schema has
 *  no defaults today; a default added there would change the pin, as it should). */
const PINNED_PROFILE = {
  slug: "pinned",
  targetRepo: "/pinned/repo",
  defaultBranch: "main",
  checksSystem: "none",
  components: [
    {
      name: "app",
      kind: "ruby",
      paths: ["app/**"],
      commands: { build: "true", test: "true", check: "true" },
    },
    {
      name: "lib",
      kind: "ruby",
      paths: ["lib/**"],
      commands: { build: "true", test: "true", check: "true" },
      testPolicy: { suite: "required" },
    },
  ],
  promptVars: { stack: "ruby" },
  runtimeContext: {
    topology: { type: "cli" },
    data: { presence: "absent" },
    caching: { presence: "absent" },
    observability: { presence: "absent" },
    configSecrets: { presence: "absent" },
    documentation: { presence: "absent" },
    releasePackaging: { mechanism: "none" },
  },
};

function computed(): Record<string, string> {
  const out: Record<string, string> = {};
  const { db } = makeTestDb({ seedTicket: false });
  try {
    const projectId = insertProject(db, { slug: "pinned", targetRepo: "/pinned/repo" });
    const ticketId = insertTicket(db, {
      projectId,
      ident: "ENG-1",
      title: "Pinned title",
      description: "Pinned body",
    });
    // The snapshot digests as captureSnapshot records them, which is what a manifest compares.
    captureSnapshot(db, ticketId, {
      profile: parseProfile(PINNED_PROFILE),
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: DEFAULT_RUNTIME_CONFIG,
    });
    for (const row of listInputs(db, ticketId)) out[`snapshot ${row.name}`] = row.digest;
    insertWorkUnit(db, {
      ticketId,
      seq: 1,
      kind: "backend",
      title: "Unit 1",
      description: "Change 1",
      behavioral: 1,
      testPlan: "test/u1_test.rb asserts change 1",
      filesToTouch: ["lib/u1.rb", "test/u1_test.rb"],
      verifyCheckTypes: ["test"],
      dependsOn: [],
    });
    insertWorkUnit(db, {
      ticketId,
      seq: 2,
      kind: "backend",
      title: "Unit 2",
      description: "Change 2",
      behavioral: 0,
      testPlan: null,
      filesToTouch: ["lib/u2.rb"],
      verifyCheckTypes: [],
      dependsOn: [1],
    });
    setNeedsDocs(db, ticketId, 1);
    setTicketTrack(db, ticketId, "full");
    out["output workUnits"] = digestWorkUnits(db, ticketId);
    out["output track"] = digestTrack(db, ticketId);
  } finally {
    db.close();
  }
  out["output plan"] = planDigestOf([
    { path: "docs/plans/eng-1-plan.md", content: "---\nlinear: ENG-1\n---\n\nPinned plan\n" },
  ]);
  for (const row of DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step")) {
    for (const complexityGrading of [false, true]) {
      // Sorted: a manifest is a map, so the order a row lists its inputs in never reaches a digest.
      const key = `declared ${row.stepKey} grading ${complexityGrading ? "on" : "off"}`;
      out[key] = digestValue([...row.inputs({ complexityGrading })].sort());
    }
  }
  return out;
}

test(`the digests of a fixed set of inputs are those pinned for scheme ${FINGERPRINT_SCHEME}`, () => {
  // Failing? Something a recorded digest depends on changed. Decide it deliberately: bump
  // FINGERPRINT_SCHEME (spec §5.1) and add the new pin under the new number.
  expect(computed()).toEqual(PINNED[FINGERPRINT_SCHEME] ?? {});
});
