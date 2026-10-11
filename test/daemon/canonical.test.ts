// test/daemon/canonical.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  FINGERPRINT_SCHEME,
  canonicalJson,
  digestValue,
  sha256Hex,
} from "../../src/daemon/canonical.ts";

test("object key order does not change the encoding; keys come out sorted", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  expect(a).toBe(b);
  expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test("keys that look like integers are sorted as strings, not in JavaScript's own key order", () => {
  expect(canonicalJson({ "9": "x", "10": "y" })).toBe('{"10":"y","9":"x"}');
});

test("strings and keys are normalised to NFC", () => {
  // Escapes, so no editor or copy can normalise the two spellings into one.
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  expect(composed).not.toBe(decomposed);
  expect(canonicalJson({ [decomposed]: decomposed })).toBe(canonicalJson({ [composed]: composed }));
});

test("undefined members are dropped and null is kept", () => {
  expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
});

test("array order is meaningful and kept", () => {
  expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
});

test("values that have no canonical form are refused loudly", () => {
  expect(() => canonicalJson({ n: Number.NaN })).toThrow("non-finite");
  expect(() => canonicalJson({ d: new Date(0) })).toThrow("unsupported");
  expect(() => canonicalJson({ m: new Map() })).toThrow("unsupported");
  expect(() => canonicalJson([undefined])).toThrow("undefined");
  expect(() => canonicalJson({ b: 1n })).toThrow("unsupported");
});

test("digestValue is the SHA-256 of the canonical encoding", () => {
  const v = { z: [1, "a"], a: true };
  expect(digestValue(v)).toBe(createHash("sha256").update(canonicalJson(v), "utf8").digest("hex"));
  expect(sha256Hex("x")).toHaveLength(64);
});

// Tests below go beyond the brief: each pins one rule of spec §5.1 the brief's seven tests leave
// to a combined assertion, or a refusal path the brief's code has but does not exercise.

test("the scheme constant is 1", () => {
  expect(FINGERPRINT_SCHEME).toBe(1);
});

test("the digest format is 64 lowercase hex characters and matches known SHA-256 vectors", () => {
  expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(digestValue({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  // The digest is of the canonical text: {"a":1}
  expect(digestValue({ a: 1 })).toBe(sha256Hex('{"a":1}'));
});

test("digests are over UTF-8 bytes, so a non-ASCII value digests its encoded bytes", () => {
  expect(sha256Hex("\u00e9")).toBe(
    createHash("sha256")
      .update(Buffer.from([0xc3, 0xa9]))
      .digest("hex"),
  );
});

test("object keys are sorted at every depth, inside arrays included", () => {
  const out = canonicalJson({ z: [{ b: 1, a: { y: 1, x: 2 } }], a: 0 });
  expect(out).toBe('{"a":0,"z":[{"a":{"x":2,"y":1},"b":1}]}');
});

test("array order is kept: elements are not sorted", () => {
  expect(canonicalJson(["b", "a", "c"])).toBe('["b","a","c"]');
  expect(canonicalJson([{ k: 2 }, { k: 1 }])).toBe('[{"k":2},{"k":1}]');
});

test("a string value alone is normalised to NFC (key untouched)", () => {
  expect(canonicalJson({ k: "cafe\u0301" })).toBe(canonicalJson({ k: "caf\u00e9" }));
  expect(canonicalJson("cafe\u0301")).toBe(JSON.stringify("caf\u00e9"));
});

test("a key alone is normalised to NFC (value untouched)", () => {
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  expect(canonicalJson({ [decomposed]: 1 })).toBe(canonicalJson({ [composed]: 1 }));
  expect(canonicalJson({ [decomposed]: 1 })).toBe(`{${JSON.stringify(composed)}:1}`);
});

test("keys are sorted after NFC, so a decomposed key sorts where its composed form does", () => {
  // Composed e-acute (U+00E9) sorts after "f"; the decomposed spelling starts with "e" and would
  // sort before it if the sort ran on the raw keys.
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  const out = canonicalJson({ f: 1, [composed]: 2 });
  expect(canonicalJson({ f: 1, [decomposed]: 2 })).toBe(out);
  expect(out).toBe(`{"f":1,${JSON.stringify(composed)}:2}`);
});

test("keys sort by UTF-16 code unit order, which is stable across runtimes", () => {
  // U+10000 is the surrogate pair D800 DC00, which sorts before U+FFFF in code unit order.
  expect(canonicalJson({ "\uffff": 1, "\u{10000}": 2 })).toBe(
    `{${JSON.stringify("\u{10000}")}:2,${JSON.stringify("\uffff")}:1}`,
  );
});

test("two keys that normalise to the same text are refused, naming the key and the place", () => {
  expect(() => canonicalJson({ caf\u00e9: 1, cafe\u0301: 2 })).toThrow(
    /two keys normalise to "caf\u00e9" at \$/,
  );
  expect(() => canonicalJson({ n: { caf\u00e9: 1, cafe\u0301: 2 } })).toThrow("at $.n");
});

test("an undefined member is dropped at depth and does not leave a stray comma", () => {
  expect(canonicalJson({ a: { x: undefined, y: 1, z: undefined }, b: undefined })).toBe(
    '{"a":{"y":1}}',
  );
  expect(canonicalJson({ a: undefined })).toBe("{}");
  expect(canonicalJson({ a: undefined, b: undefined })).toBe("{}");
});

test("an undefined member is dropped the same as a missing member", () => {
  expect(digestValue({ a: 1, b: undefined })).toBe(digestValue({ a: 1 }));
});

test("scalars, null, empty containers and numbers encode as JSON", () => {
  expect(canonicalJson(null)).toBe("null");
  expect(canonicalJson(true)).toBe("true");
  expect(canonicalJson(false)).toBe("false");
  expect(canonicalJson(0)).toBe("0");
  expect(canonicalJson(-1.5)).toBe("-1.5");
  expect(canonicalJson([])).toBe("[]");
  expect(canonicalJson({})).toBe("{}");
  expect(canonicalJson('a"b\n')).toBe('"a\\"b\\n"');
});

test("objects with a null prototype are accepted and sorted like plain objects", () => {
  const o = Object.create(null) as Record<string, unknown>;
  o.b = 1;
  o.a = 2;
  expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
});

test("non-finite numbers of every kind are refused, naming the place", () => {
  expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow("non-finite number at $");
  expect(() => canonicalJson([1, Number.NEGATIVE_INFINITY])).toThrow("at $[1]");
  expect(() => canonicalJson({ a: { b: Number.NaN } })).toThrow("at $.a.b");
});

test("an undefined array element is refused, naming the index", () => {
  expect(() => canonicalJson({ l: [1, undefined] })).toThrow("undefined array element at $.l[1]");
  // A sparse array hole reads as undefined and is refused the same way.
  // biome-ignore lint/suspicious/noSparseArray: the hole is the point of this case
  expect(() => canonicalJson([1, , 3])).toThrow("undefined array element at $[1]");
});

test("a top level undefined, a function and a symbol are refused as unsupported", () => {
  expect(() => canonicalJson(undefined)).toThrow("unsupported undefined at $");
  expect(() => canonicalJson({ f: () => 1 })).toThrow("unsupported function at $.f");
  expect(() => canonicalJson(Symbol("s"))).toThrow("unsupported symbol at $");
});

test("class instances, sets and typed arrays are refused as unsupported objects", () => {
  class Box {
    v = 1;
  }
  expect(() => canonicalJson(new Box())).toThrow("unsupported object at $");
  expect(() => canonicalJson({ s: new Set([1]) })).toThrow("unsupported object at $.s");
  expect(() => canonicalJson(new Uint8Array(1))).toThrow("unsupported object");
});

test("keys that need JSON escaping are escaped, so the encoding stays valid JSON", () => {
  const out = canonicalJson({ 'a"b\\c\n': 1, "": 2 });
  expect(out).toBe('{"":2,"a\\"b\\\\c\\n":1}');
  expect(JSON.parse(out)).toEqual({ 'a"b\\c\n': 1, "": 2 });
});
