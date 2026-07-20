import { expect, test } from "bun:test";
import { EXIT, StyreError, configError, toolchainError, usageError } from "../../src/cli/errors.ts";

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
