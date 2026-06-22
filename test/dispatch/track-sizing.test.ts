import { expect, test } from "bun:test";
import { combineTrack, sizeTrack } from "../../src/dispatch/track-sizing.ts";

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

test("combineTrack: high complexity → full even with 1 unit (the auth-one-file case)", () => {
  expect(combineTrack(1, 5)).toBe("full");
  expect(combineTrack(1, 9)).toBe("full");
});

test("combineTrack: low complexity + few units → fast (the simple-multi-piece/docs case)", () => {
  expect(combineTrack(3, 2)).toBe("fast");
  expect(combineTrack(4, 4)).toBe("fast");
});

test("combineTrack: sprawl floor forces full regardless of a low grade", () => {
  expect(combineTrack(5, 0)).toBe("full");
  expect(combineTrack(8, 1)).toBe("full");
});

test("combineTrack: trivial single unit → fast", () => {
  expect(combineTrack(1, 0)).toBe("fast");
});
