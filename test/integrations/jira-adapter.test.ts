import { expect, test } from "bun:test";
import {
  adfComment,
  commentHasMarker,
  jiraTypeLabel,
  labelUpdateOps,
  mapJiraError,
  pickTransition,
  projKeyMarker,
  resolveStatusTarget,
} from "../../src/integrations/adapters/jira.ts";

test("jiraTypeLabel: Bug -> Bug, everything else -> Feature; bugTypeNames override", () => {
  expect(jiraTypeLabel("Bug")).toBe("Bug");
  expect(jiraTypeLabel("Story")).toBe("Feature");
  expect(jiraTypeLabel("Task")).toBe("Feature");
  expect(jiraTypeLabel("Defect", ["Bug", "Defect"])).toBe("Bug");
  expect(jiraTypeLabel("bug")).toBe("Bug"); // case-insensitive
});

test("resolveStatusTarget: defaults + config override", () => {
  expect(resolveStatusTarget("in_progress")).toEqual({ status: "In Progress" });
  expect(resolveStatusTarget("done")).toEqual({ status: "Done", resolution: "Done" });
  expect(resolveStatusTarget("canceled")).toEqual({ status: "Done", resolution: "Won't Do" });
  expect(
    resolveStatusTarget("in_review", { statusMap: { in_review: { status: "Reviewing" } } }),
  ).toEqual({ status: "Reviewing" });
});

const tr = (
  id: string,
  toName: string,
  fields?: Record<string, { required: boolean; hasDefaultValue?: boolean }>,
) => ({ id, name: `to ${toName}`, to: { name: toName }, fields });

test("pickTransition: matches target status by name (case-insensitive)", () => {
  const pick = pickTransition([tr("11", "In Progress"), tr("21", "Done")], {
    status: "in progress",
  });
  expect(pick).toEqual({ kind: "found", id: "11", setResolution: false });
});

test("pickTransition: no transition to the target -> none", () => {
  expect(pickTransition([tr("21", "Done")], { status: "In Review" })).toEqual({ kind: "none" });
});

test("pickTransition: required resolution present on screen + configured -> found w/ setResolution", () => {
  const pick = pickTransition([tr("31", "Done", { resolution: { required: true } })], {
    status: "Done",
    resolution: "Done",
  });
  expect(pick).toEqual({ kind: "found", id: "31", setResolution: true });
});

test("pickTransition: required resolution but none configured -> unsatisfiable", () => {
  const pick = pickTransition([tr("31", "Done", { resolution: { required: true } })], {
    status: "Done",
  });
  expect(pick).toEqual({ kind: "unsatisfiable" });
});

test("pickTransition: an OTHER required field we cannot supply -> unsatisfiable", () => {
  const pick = pickTransition([tr("41", "Done", { customfield_1: { required: true } })], {
    status: "Done",
    resolution: "Done",
  });
  expect(pick).toEqual({ kind: "unsatisfiable" });
});

test("pickTransition: a required field with hasDefaultValue -> JIRA auto-fills, so found", () => {
  const pick = pickTransition(
    [tr("51", "Done", { resolution: { required: true, hasDefaultValue: true } })],
    { status: "Done" }, // no configured resolution, but JIRA defaults it
  );
  expect(pick).toEqual({ kind: "found", id: "51", setResolution: false });
});

test("labelUpdateOps: atomic add/remove ops", () => {
  expect(labelUpdateOps({ add: ["styre"], remove: ["old"] })).toEqual({
    update: { labels: [{ add: "styre" }, { remove: "old" }] },
  });
});

test("projKeyMarker / adfComment / commentHasMarker round-trip", () => {
  const marker = projKeyMarker("k1");
  expect(marker).toBe("[proj-key:k1]");
  const adf = adfComment("hello", "k1");
  expect(JSON.stringify(adf)).toContain("hello");
  expect(JSON.stringify(adf)).toContain(marker);
  expect(commentHasMarker([adfComment("other", "k1")], "k1")).toBe(true);
  expect(commentHasMarker([adfComment("other", "k2")], "k1")).toBe(false);
});

test("mapJiraError: 401 -> expired/invalid token; parses JIRA error body", () => {
  const e401 = mapJiraError(401, "unauth");
  expect(e401.status).toBe(401);
  expect(e401.message).toContain("expired");
  const e400 = mapJiraError(
    400,
    JSON.stringify({ errorMessages: ["bad field"], errors: { resolution: "required" } }),
  );
  expect(e400.status).toBe(400);
  expect(e400.message).toContain("bad field");
  expect(e400.message).toContain("required");
});
