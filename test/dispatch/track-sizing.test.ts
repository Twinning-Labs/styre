import { expect, test } from "bun:test";
import { sizeTrack } from "../../src/dispatch/track-sizing.ts";

test("a single work unit is fast-track", () => {
  expect(sizeTrack([{ id: 1 }])).toBe("fast");
});

test("two or more work units is full-track", () => {
  expect(sizeTrack([{ id: 1 }, { id: 2 }])).toBe("full");
  expect(sizeTrack([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe("full");
});

test("an empty breakdown is fast-track (degenerate; extract guarantees >=1)", () => {
  expect(sizeTrack([])).toBe("fast");
});
