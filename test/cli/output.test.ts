import { expect, test } from "bun:test";
import { EXIT, StyreError, configError } from "../../src/cli/errors.ts";
import { formatMessage, guard, renderError, renderInternal } from "../../src/cli/output.ts";

test("formatMessage prefixes styre <cmd>: and indents detail", () => {
  const s = formatMessage("run", "boom", "line1\nline2", "do this");
  expect(s).toBe("styre run: boom\n  line1\n  line2\ndo this");
});

test("renderError renders a StyreError's headline/detail/recovery", () => {
  const s = renderError(
    "run",
    configError({ file: "/c.json", field: "notifier", detail: "got 'x'" }),
  );
  expect(s).toContain("styre run: invalid config");
  expect(s).toContain("/c.json");
  expect(s).toContain("got 'x'");
});

test("renderInternal shows a please-report banner, message as detail, no stack by default", () => {
  const s = renderInternal("run", new Error("kaboom"));
  expect(s).toContain("internal error");
  expect(s).toContain("kaboom");
  expect(s).not.toContain("at "); // no stack frames without DEBUG
});

test("guard: StyreError → renders once, sets its code, does not rethrow", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    throw new StyreError({ code: EXIT.CONFIG, headline: "bad config" });
  });
  expect(process.exitCode).toBe(EXIT.CONFIG);
  process.exitCode = 0; // reset for the suite
});

test("guard: non-StyreError → EXIT.INTERNAL, no rethrow", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    throw new Error("unexpected");
  });
  expect(process.exitCode).toBe(EXIT.INTERNAL);
  process.exitCode = 0;
});

test("guard: clean body leaves exitCode untouched", async () => {
  process.exitCode = 0;
  await guard("run", async () => {
    process.exitCode = 75; // e.g. parked
  });
  expect(process.exitCode).toBe(75);
  process.exitCode = 0;
});
