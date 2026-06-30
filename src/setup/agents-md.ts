import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Cap injected AGENTS.md content — bounds prompt growth and prompt-injection surface (not a
 *  security control). */
export const AGENTS_MD_CAP = 16_384;

/** Read the repo's root AGENTS.md (the agent-onboarding standard). Returns "" when absent,
 *  a symlink, unreadable, or not a regular file (never throws) — `lstatSync` rejects symlinks so a
 *  hostile `AGENTS.md -> /etc/passwd` cannot read a host file into the prompt. Oversized files are
 *  truncated with a marker. */
export function readAgentsMd(repoDir: string): string {
  const path = join(repoDir, "AGENTS.md");
  try {
    if (!lstatSync(path).isFile()) return ""; // isFile() is false for symlinks and directories
    const text = readFileSync(path, "utf8");
    return text.length <= AGENTS_MD_CAP ? text : `${text.slice(0, AGENTS_MD_CAP)}\n…[truncated]`;
  } catch {
    return "";
  }
}
