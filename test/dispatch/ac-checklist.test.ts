import { describe, expect, test } from "bun:test";
import { parseAcChecklist } from "../../src/dispatch/ac-checklist.ts";

describe("parseAcChecklist", () => {
  test("each GFM task-list item is one checklist AC (text trimmed)", () => {
    const desc = [
      "## Acceptance criteria",
      "",
      "- [ ] The endpoint returns 200 for a valid request",
      "- [x] Invalid input yields a 400",
      "* [ ] Auth is required on all routes",
      "+ [ ] Errors are logged",
    ].join("\n");
    expect(parseAcChecklist(desc)).toEqual([
      { text: "The endpoint returns 200 for a valid request", source: "checklist" },
      { text: "Invalid input yields a 400", source: "checklist" },
      { text: "Auth is required on all routes", source: "checklist" },
      { text: "Errors are logged", source: "checklist" },
    ]);
  });

  test("indented task-list items are still captured", () => {
    const desc = "  - [ ] nested item";
    expect(parseAcChecklist(desc)).toEqual([{ text: "nested item", source: "checklist" }]);
  });

  test("no task-list items ⇒ the whole (trimmed) description is one whole-description AC", () => {
    const desc = "\nFix the collection error so pytest can import the module.\n";
    expect(parseAcChecklist(desc)).toEqual([
      {
        text: "Fix the collection error so pytest can import the module.",
        source: "whole-description",
      },
    ]);
  });

  test("a bare '- [ ]' with no text is not a task item ⇒ falls back to whole-description", () => {
    const desc = "- [ ]";
    expect(parseAcChecklist(desc)).toEqual([{ text: "- [ ]", source: "whole-description" }]);
  });

  test("empty / whitespace-only / null description ⇒ no ACs", () => {
    expect(parseAcChecklist("")).toEqual([]);
    expect(parseAcChecklist("   \n  \t")).toEqual([]);
    expect(parseAcChecklist(null)).toEqual([]);
  });
});
