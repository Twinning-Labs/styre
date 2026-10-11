// src/daemon/canonical.ts
import { createHash } from "node:crypto";

/** The version of everything a recorded digest depends on (spec §5.1): this encoding, how the
 *  profile and config are parsed (their defaults included), what each table step declares, and how
 *  each output is digested. A manifest recorded under an older scheme counts as changed (operator
 *  ruling, 2026-10-09): the step reruns the next time the run is in design. Bump it deliberately in
 *  a release that changes any of those; test/daemon/fingerprint-pin.test.ts fails until the bump
 *  and a new pin are made. */
export const FINGERPRINT_SCHEME = 1;

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.normalize("NFC"));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    // Array.from, not .map: .map skips the holes of a sparse array and would emit `[1,,3]`.
    return `[${Array.from(v, (x, i) => {
      if (x === undefined)
        throw new Error(`canonicalJson: undefined array element at ${path}[${i}]`);
      return write(x, `${path}[${i}]`);
    }).join(",")}]`;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
      throw new Error(`canonicalJson: unsupported object at ${path}`);
    const entries = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k.normalize("NFC"), (v as Record<string, unknown>)[k]] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][0] === entries[i - 1][0])
        throw new Error(`canonicalJson: two keys normalise to "${entries[i][0]}" at ${path}`);
    }
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${write(x, `${path}.${k}`)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
}

/** JSON with object keys sorted and every string normalised to NFC (spec §5.1). Built by hand, so
 *  keys that look like integers are not reordered by JavaScript. Throws on anything JSON cannot say exactly. */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
