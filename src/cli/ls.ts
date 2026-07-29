import { defineCommand } from "citty";
import { type Checkpoint, listCheckpoints } from "./checkpoints.ts";
import { guard } from "./output.ts";

/** `<60min → "<m>m"`, `<24h → "<h>h"`, else `"<d>d"` — integer floors. */
export function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(ms / 86_400_000);
  return `${days}d`;
}

function row(c: Checkpoint): string {
  return `  ${c.ident}  [${c.kind}, ${humanAge(c.ageMs)}]  ${c.note ?? ""}`.trimEnd();
}

function leftoverRow(c: Checkpoint): string {
  return `  ${c.slug}/${c.ident}  [${c.kind}, ${humanAge(c.ageMs)}]  ${c.note ?? ""}`.trimEnd();
}

export async function lsImpl(opts?: { root?: string }): Promise<void> {
  const all = listCheckpoints(opts?.root);

  const resumable = all.filter((c) => c.resumable && !c.live).sort((a, b) => a.ageMs - b.ageMs);
  const leftovers = all.filter((c) => (c.kind === "pr-ready" || c.kind === "done") && !c.live);
  const running = all.filter((c) => c.live);

  const lines: string[] = [];

  lines.push("Paused/resumable efforts:");
  if (resumable.length === 0) {
    lines.push("No paused efforts.");
  } else {
    for (const c of resumable) {
      lines.push(row(c));
      lines.push(`    resume: styre run --resume ${c.ident} --slug ${c.slug}`);
    }
  }

  if (leftovers.length > 0) {
    lines.push("");
    lines.push("Finished leftovers (reap per project with `styre clean --all`):");
    for (const c of leftovers) {
      lines.push(leftoverRow(c));
    }
  }

  if (running.length > 0) {
    lines.push("");
    lines.push("Running:");
    for (const c of running) {
      lines.push(`  ${c.ident}  [${c.kind}, ${humanAge(c.ageMs)}]`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

export const lsCommand = defineCommand({
  meta: { name: "ls", description: "List paused/resumable styre efforts and finished leftovers." },
  run: () => guard("ls", () => lsImpl()),
});
