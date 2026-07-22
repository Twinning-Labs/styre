import { expect, test } from "bun:test";
import {
  EXIT,
  StyreError,
  agentCliError,
  configError,
  errorKindForExit,
  toolchainError,
  usageError,
} from "../../src/cli/errors.ts";

test("StyreError carries code + headline + optional detail/recovery", () => {
  const e = new StyreError({ code: 78, headline: "bad", detail: "d", recovery: "fix it" });
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe(78);
  expect(e.headline).toBe("bad");
  expect(e.detail).toBe("d");
  expect(e.recovery).toBe("fix it");
  expect(e.message).toBe("bad"); // Error.message mirrors the headline
});

test("usageError uses EXIT.USAGE (64)", () => {
  const e = usageError("--ticket is required", "Pass a ticket ref.");
  expect(e.code).toBe(EXIT.USAGE);
  expect(EXIT.USAGE).toBe(64);
  expect(e.recovery).toBe("Pass a ticket ref.");
});

test("configError names the file and defaults a recovery line", () => {
  const e = configError({ file: "/x/config.json", field: "notifier", detail: "got 'slaack'" });
  expect(e.code).toBe(EXIT.CONFIG);
  expect(EXIT.CONFIG).toBe(78);
  expect(e.headline).toContain("/x/config.json");
  expect(e.headline).toContain("notifier");
  expect(e.recovery).toBeDefined();
});

test("toolchainError uses EXIT.TOOLCHAIN_MISSING (69)", () => {
  expect(toolchainError("  - pytest").code).toBe(69);
});

test("errorKindForExit maps each EXIT code to its kind", () => {
  expect(errorKindForExit(EXIT.USAGE)).toBe("usage");
  expect(errorKindForExit(EXIT.CONFIG)).toBe("config");
  expect(errorKindForExit(EXIT.TOOLCHAIN_MISSING)).toBe("toolchain");
  expect(errorKindForExit(EXIT.RESUME_REFUSED)).toBe("resume_refused");
  expect(errorKindForExit(EXIT.OPERATIONAL)).toBe("operational");
  expect(errorKindForExit(EXIT.TEMPFAIL)).toBe("tempfail");
  expect(errorKindForExit(EXIT.INTERNAL)).toBe("internal");
});

test("errorKindForExit falls back to 'other' for an unknown code", () => {
  expect(errorKindForExit(0)).toBe("other");
  expect(errorKindForExit(255)).toBe("other");
});

test("agentCliError(missing) → exit 69, 'not installed' headline, install recovery", () => {
  const e = agentCliError({ reason: "missing", command: "claude" });
  expect(e.code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect(e.headline).toMatch(/claude is not installed or not on PATH/);
  expect(e.recovery).toMatch(/Install the 'claude' CLI/);
});

test("agentCliError(unsupported-version) → exit 69, upgrade headline naming found+required", () => {
  const e = agentCliError({
    reason: "unsupported-version",
    command: "claude",
    found: "2.0.9",
    required: "2.1.200",
  });
  expect(e.code).toBe(EXIT.TOOLCHAIN_MISSING);
  expect(e.headline).toMatch(/claude 2\.0\.9 is below the supported minimum 2\.1\.200/);
  expect(e.recovery).toMatch(/Upgrade the 'claude' CLI to >= 2\.1\.200/);
});
