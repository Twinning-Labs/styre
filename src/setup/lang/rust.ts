import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findManifests, safeMember } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

/** Parse `members = [ "a", "b" ]` from a Cargo [workspace] manifest (best-effort). */
function cargoWorkspaceMembers(cargoTomlAbs: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(cargoTomlAbs, "utf8");
  } catch {
    // Unreadable or permission-denied Cargo.toml — treat as "not a workspace".
    return null;
  }
  if (!/\[workspace\]/.test(text)) return null;
  const m = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * Collapse a list of workspace member paths into a minimal set of globs.
 * Members that share a common parent directory (e.g. "crates/a", "crates/b") are
 * collapsed into a single wildcard glob ("crates/**") to avoid per-member path sprawl.
 * Top-level members ("src-tauri") stay as-is ("src-tauri/**").
 */
function collapseWorkspaceGlobs(members: string[]): string[] {
  const topLevel: string[] = [];
  const byParent = new Map<string, string[]>();

  for (const member of members) {
    const slashIdx = member.indexOf("/");
    if (slashIdx === -1) {
      // Direct child like "src-tauri"
      topLevel.push(`${member}/**`);
    } else {
      const parent = member.slice(0, slashIdx);
      const list = byParent.get(parent) ?? [];
      list.push(member);
      byParent.set(parent, list);
    }
  }

  const result = [...topLevel];
  for (const parent of byParent.keys()) {
    result.push(`${parent}/**`);
  }
  return result;
}

export const rustDef: LangDef = {
  kind: "rust",
  detect(repoDir: string): ComponentDraft[] {
    const cargoRoot = join(repoDir, "Cargo.toml");
    const workspaceMembers = existsSync(cargoRoot) ? cargoWorkspaceMembers(cargoRoot) : null;
    if (workspaceMembers) {
      const collapsed = collapseWorkspaceGlobs(workspaceMembers.filter(safeMember));
      const paths = ["Cargo.toml", "Cargo.lock", ...collapsed];
      return [
        {
          name: "rust-core",
          kind: "rust",
          paths,
          commands: { build: "cargo build --workspace", test: "cargo test --workspace" },
        },
      ];
    }
    const components: ComponentDraft[] = [];
    for (const rel of findManifests(repoDir, "Cargo.toml")) {
      const dir = rel.replace(/Cargo\.toml$/, "").replace(/\/$/, "");
      components.push({
        name: dir === "" ? "rust" : dir.replace(/\//g, "-"),
        kind: "rust",
        ...(dir === "" ? {} : { dir }),
        paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "cargo build", test: "cargo test" },
      });
    }
    return components;
  },
};
