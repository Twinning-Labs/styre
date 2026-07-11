/** Minimal ADF (Atlassian Document Format) -> Markdown renderer. ONE direction, for JIRA Cloud v3
 *  issue DESCRIPTIONS (always an ADF `doc` or null). We render to markdown so the existing
 *  parseAcChecklist sees GFM task-list items — the taskList/taskItem node is the load-bearing case
 *  (that is how a JIRA checklist becomes acceptance criteria). Unknown nodes degrade to their text
 *  content; the renderer never throws. Pure + unit-tested. Comments do NOT use this. */

type Mark = { type: string; attrs?: Record<string, unknown> };
type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
};

function applyMarks(text: string, marks?: Mark[]): string {
  if (!marks) return text;
  let out = text;
  for (const m of marks) {
    if (m.type === "strong") out = `**${out}**`;
    else if (m.type === "em") out = `*${out}*`;
    else if (m.type === "code") out = `\`${out}\``;
    else if (m.type === "link") out = `[${out}](${(m.attrs?.href as string) ?? ""})`;
  }
  return out;
}

function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += applyMarks(n.text ?? "", n.marks);
    else if (n.type === "hardBreak") out += "\n";
    else out += renderInline(n.content); // unknown inline → its text
  }
  return out;
}

function renderList(node: AdfNode, marker: (i: number) => string, indent: string): string {
  return (node.content ?? [])
    .map((item, i) => `${indent}${marker(i)} ${renderInline(item.content?.[0]?.content).trim()}`)
    .join("\n");
}

function renderTaskList(node: AdfNode, indent: string): string {
  return (node.content ?? [])
    .map((item) => {
      const box = item.attrs?.state === "DONE" ? "[x]" : "[ ]";
      return `${indent}- ${box} ${renderInline(item.content)}`;
    })
    .join("\n");
}

function renderBlock(node: AdfNode, indent: string): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${renderInline(node.content)}`;
    }
    case "bulletList":
      return renderList(node, () => "-", indent);
    case "orderedList":
      return renderList(node, (i) => `${i + 1}.`, indent);
    case "taskList":
      return renderTaskList(node, indent);
    case "codeBlock":
      return `\`\`\`${(node.attrs?.language as string) ?? ""}\n${renderInline(node.content)}\n\`\`\``;
    case "blockquote":
      return renderBlocks(node.content ?? [], indent)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    default:
      return node.content ? renderBlocks(node.content, indent) : (node.text ?? "");
  }
}

function renderBlocks(nodes: AdfNode[], indent: string): string {
  return nodes
    .map((n) => renderBlock(n, indent))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const root = doc as AdfNode;
  if (root.type !== "doc" || !root.content) return "";
  return renderBlocks(root.content, "");
}
