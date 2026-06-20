import { expect, test } from "bun:test";
import { z } from "zod";
import { extractSidecar } from "../../src/dispatch/sidecar.ts";

const Schema = z.object({ units: z.number() });

function block(body: string): string {
  return ["Here is my answer.", "```styre-sidecar", body, "```", "Done."].join("\n");
}

test("extracts and validates a well-formed sidecar block", () => {
  const r = extractSidecar(block(`{ "units": 2 }`), Schema);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.units).toBe(2);
  }
});

test("reports absent when there is no sidecar fence", () => {
  const r = extractSidecar("just prose, no block", Schema);
  expect(r).toMatchObject({ ok: false, reason: "absent" });
});

test("reports malformed on invalid JSON", () => {
  const r = extractSidecar(block("{ not json }"), Schema);
  expect(r).toMatchObject({ ok: false, reason: "malformed" });
});

test("reports malformed when JSON fails the schema", () => {
  const r = extractSidecar(block(`{ "units": "two" }`), Schema);
  expect(r).toMatchObject({ ok: false, reason: "malformed" });
});

test("respects a custom fence label", () => {
  const out = ["```findings", `{ "units": 1 }`, "```"].join("\n");
  const r = extractSidecar(out, Schema, { fence: "findings" });
  expect(r.ok).toBe(true);
});
