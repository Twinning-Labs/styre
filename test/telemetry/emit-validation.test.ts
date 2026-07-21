import { describe, expect, test } from "bun:test";
import { stdoutSink } from "../../src/telemetry/emit.ts";

describe("stdoutSink validation (non-fatal)", () => {
  test("does not throw on a malformed event", () => {
    // A structurally-invalid event must not throw on the live wire (best-effort telemetry, §5.3).
    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed event for the non-fatal-validation test
    expect(() => stdoutSink({ type: "summary" } as any)).not.toThrow();
  });

  test("emits a valid event without complaint", () => {
    const valid = {
      schema_version: 2,
      type: "ci_handoff",
      run_id: "r1",
      ticket_id: 1,
      ident: "ENG-1",
      pr_ref: null,
      pr_url: null,
      branch_head_sha: null,
      checks_system: "github",
      read: "not-reported",
      measured_at: "t0",
    };
    // biome-ignore lint/suspicious/noExplicitAny: bypass literal narrowing so `valid` can be shaped as a plain object above
    expect(() => stdoutSink(valid as any)).not.toThrow();
  });
});
