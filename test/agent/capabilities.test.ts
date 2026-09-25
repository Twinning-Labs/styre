import { expect, test } from "bun:test";
import { toolNamesFor, toolSetMismatch } from "../../src/agent/capabilities.ts";

test("toolNamesFor reduces permission entries to their exact, sorted, unique tool names", () => {
  expect(toolNamesFor(["Read", "Grep", "Glob"])).toEqual(["Glob", "Grep", "Read"]);
  // scoped Bash entries grant the Bash tool once, whatever the command patterns
  expect(
    toolNamesFor(["Read", "Write", "Bash(npm test:*)", "Bash(python3 -m pytest:*)", "Edit"]),
  ).toEqual(["Bash", "Edit", "Read", "Write"]);
  expect(toolNamesFor([])).toEqual([]);
});

test("toolSetMismatch is null only when the effective set equals the expected set exactly", () => {
  expect(toolSetMismatch(["Glob", "Grep", "Read"], ["Read", "Glob", "Grep"])).toBeNull();
  expect(toolSetMismatch(["Glob", "Grep", "Read"], ["Glob", "Grep", "Read", "Bash"])).toBe(
    "unexpected tools: Bash",
  );
  expect(toolSetMismatch(["Bash", "Read"], ["Read"])).toBe("missing tools: Bash");
  expect(toolSetMismatch(["Read"], ["Write"])).toBe("missing tools: Read; unexpected tools: Write");
});
