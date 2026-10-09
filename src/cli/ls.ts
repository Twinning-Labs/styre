import { defineCommand } from "citty";
import { printable } from "../util/process/printable.ts";
import type { LaunchRecord } from "../util/process/records.ts";
import { sweepOrphans } from "../util/process/sweep.ts";
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

/** One orphan the sweep stopped, for `ls`'s human output (section 8). */
function sweptRow(r: LaunchRecord): string {
  // The ident comes from the record file: its control characters are replaced, as the command's are.
  const ident = r.ident === null ? "an unknown run" : printable(r.ident);
  return `  ${ident}  [${r.kind}, pid ${r.pid}]  ${r.command}`.trimEnd();
}

export async function lsImpl(opts?: { root?: string; swept?: LaunchRecord[] }): Promise<void> {
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

  const swept = opts?.swept ?? [];
  if (swept.length > 0) {
    lines.push("");
    lines.push("Stopped orphans (left running when Styre was force quit):");
    for (const r of swept) lines.push(sweptRow(r));
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

export const lsCommand = defineCommand({
  meta: { name: "ls", description: "List paused/resumable styre efforts and finished leftovers." },
  // The sweep runs first, inside the error boundary (section 8); `ls` also lists what it stopped.
  run: () =>
    guard("ls", async () => {
      const swept = await sweepOrphans();
      await lsImpl({ swept: swept.stopped });
    }),
});
