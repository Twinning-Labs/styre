import { expect, test } from "bun:test";
import {
  projKeyTag,
  resolveLabelNames,
  taggedBody,
} from "../../src/integrations/adapters/linear.ts";

test("projKeyTag / taggedBody embed a probeable idempotency tag", () => {
  const tag = projKeyTag("k1");
  expect(tag).toBe("<!-- proj-key: k1 -->");
  const body = taggedBody("hello", "k1");
  expect(body).toContain("hello");
  expect(body.includes(tag)).toBe(true);
});

test("resolveLabelNames is label-safe: preserves labels outside the delta", () => {
  const next = resolveLabelNames(
    ["keep", "stage:design"],
    { add: ["stage:implement"], remove: ["stage:design"] },
    new Set(["keep", "stage:design", "stage:implement"]),
  );
  expect(next.sort()).toEqual(["keep", "stage:implement"]);
});

test("resolveLabelNames skips an add-name that does not exist", () => {
  const next = resolveLabelNames(["keep"], { add: ["nonexistent"], remove: [] }, new Set(["keep"]));
  expect(next).toEqual(["keep"]);
});

test("resolveLabelNames skips a remove-name that is not present (no-op)", () => {
  const next = resolveLabelNames(["keep"], { add: [], remove: ["not-there"] }, new Set(["keep"]));
  expect(next).toEqual(["keep"]);
});

test("resolveLabelNames does not duplicate an already-present add", () => {
  const next = resolveLabelNames(["keep"], { add: ["keep"], remove: [] }, new Set(["keep"]));
  expect(next).toEqual(["keep"]);
});
