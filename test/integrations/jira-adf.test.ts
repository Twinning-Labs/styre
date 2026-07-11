import { expect, test } from "bun:test";
import { adfToMarkdown } from "../../src/integrations/adapters/jira-adf.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("task-list nodes become GFM checkboxes (the load-bearing case)", () => {
  const adf = doc({
    type: "taskList",
    content: [
      {
        type: "taskItem",
        attrs: { state: "DONE" },
        content: [{ type: "text", text: "done item" }],
      },
      {
        type: "taskItem",
        attrs: { state: "TODO" },
        content: [{ type: "text", text: "todo item" }],
      },
    ],
  });
  expect(adfToMarkdown(adf)).toBe("- [x] done item\n- [ ] todo item");
});

test("paragraphs, headings, and marks", () => {
  const adf = doc(
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "bold", marks: [{ type: "strong" }] },
        { type: "text", text: " and " },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "http://x" } }] },
      ],
    },
  );
  expect(adfToMarkdown(adf)).toBe("## Title\n\n**bold** and [link](http://x)");
});

test("bullet and ordered lists", () => {
  const adf = doc(
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [para("a")] },
        { type: "listItem", content: [para("b")] },
      ],
    },
    { type: "orderedList", content: [{ type: "listItem", content: [para("one")] }] },
  );
  expect(adfToMarkdown(adf)).toBe("- a\n- b\n\n1. one");
});

test("code block with language", () => {
  const adf = doc({
    type: "codeBlock",
    attrs: { language: "ts" },
    content: [{ type: "text", text: "x = 1" }],
  });
  expect(adfToMarkdown(adf)).toBe("```ts\nx = 1\n```");
});

test("unknown node degrades to its text; never throws", () => {
  const adf = doc({ type: "someFutureNode", content: [{ type: "text", text: "kept" }] });
  expect(adfToMarkdown(adf)).toBe("kept");
});

test("null / non-doc input returns empty string", () => {
  expect(adfToMarkdown(null)).toBe("");
  expect(adfToMarkdown({ type: "paragraph" })).toBe("");
  expect(adfToMarkdown("plain")).toBe("");
});

test("malformed doc with non-array content returns empty string, never throws", () => {
  expect(adfToMarkdown({ type: "doc", content: "foo" })).toBe("");
  expect(adfToMarkdown({ type: "doc", content: 5 })).toBe("");
  expect(adfToMarkdown({ type: "doc", content: { a: 1 } })).toBe("");
});

test("blockquote and em/code marks render", () => {
  const adf = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "it", marks: [{ type: "em" }] },
          { type: "text", text: " ", marks: [] },
          { type: "text", text: "co", marks: [{ type: "code" }] },
        ],
      },
    ],
  };
  expect(adfToMarkdown(adf)).toBe("> quoted\n\n*it* `co`");
});
