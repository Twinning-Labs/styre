import { expect, test } from "bun:test";
import { classifyPrior } from "../../src/dispatch/classify-prior.ts";

test("coarse error → environmental (settled)", () => {
  expect(classifyPrior({ coarse: "error", rawOutput: "" })).toEqual({
    kind: "settled-red",
    redClass: "environmental",
  });
});

test("coarse green → adjudicate-green", () => {
  expect(classifyPrior({ coarse: "green", rawOutput: "1 passed" })).toEqual({
    kind: "adjudicate-green",
  });
});

test("red with own-symbol ImportError → absence (settled)", () => {
  const out = "ImportError: cannot import name 'save_pref' from 'app.prefs'";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({
    kind: "settled-red",
    redClass: "absence",
  });
});

test("red with NameError → absence (settled)", () => {
  const out = "E   NameError: name 'save_pref' is not defined";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({
    kind: "settled-red",
    redClass: "absence",
  });
});

test("red with a bare ModuleNotFoundError → adjudicate (env vs absence ambiguous)", () => {
  const out = "ModuleNotFoundError: No module named 'redis'";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({ kind: "adjudicate-red" });
});

test("red assertion failure → adjudicate (may be a proxy-absence)", () => {
  const out = "E   assert 404 == 201";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({ kind: "adjudicate-red" });
});
