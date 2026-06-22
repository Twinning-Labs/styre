import { expect, test } from "bun:test";
import { allowlistFor } from "../../src/dispatch/tool-allowlists.ts";

test("design:dispatch gets read tools + docs Write/Edit + web, no Bash/outward", () => {
  const tools = allowlistFor("design:dispatch");
  expect(tools).toContain("Read");
  expect(tools).toContain("Write");
  expect(tools).toContain("WebSearch");
  expect(tools).not.toContain("Bash");
});

test("implement:dispatch gets full edit + Bash, no git/outward", () => {
  const tools = allowlistFor("implement:dispatch");
  expect(tools).toContain("Edit");
  expect(tools).toContain("Bash"); // unscoped fallback when no runner commands are declared
});

test("implement:dispatch scopes Bash to the profile's declared runner commands", () => {
  const tools = allowlistFor("implement:dispatch", {
    runnerCommands: ["bun run build", "bun test", "  ", "bun test"],
  });
  // bare Bash is replaced by per-runner scoped grants (control-loop S2: runners only); deduped + trimmed.
  expect(tools).not.toContain("Bash");
  expect(tools).toContain("Bash(bun run build:*)");
  expect(tools).toContain("Bash(bun test:*)");
  expect(tools.filter((t) => t === "Bash(bun test:*)").length).toBe(1);
  expect(tools).toContain("Read"); // read tools preserved
});

test("review and design:review are read-only (no Write/Edit/Bash)", () => {
  for (const key of ["review", "design:review", "design:extract"]) {
    const tools = allowlistFor(key);
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
  }
});

test("no allowlist ever contains an outward tool", () => {
  for (const key of [
    "design:dispatch",
    "implement:dispatch",
    "review",
    "design:review",
    "design:extract",
    "docs:revise",
    "merge:pr-ensure",
  ]) {
    const tools = allowlistFor(key);
    for (const outward of ["Bash(git push)", "WebFetch(gh)"]) {
      expect(tools).not.toContain(outward);
    }
    expect(tools.join(",")).not.toContain("gh");
    expect(tools.join(",")).not.toContain("git push");
  }
});

test("an unknown handlerKey throws", () => {
  expect(() => allowlistFor("verify:integration")).toThrow();
});
