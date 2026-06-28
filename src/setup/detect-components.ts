import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../dispatch/profile.ts";

const SKIP = new Set([
  "node_modules",
  "target",
  ".git",
  "dist",
  "build",
  ".svelte-kit",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".nox",
  "vendor",
  ".gradle",
  ".mvn",
  "Pods",
]);

/** Bounded-depth walk collecting manifest paths (relative to repoDir). */
function findManifests(repoDir: string, name: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      const r = rel === "" ? entry : `${rel}/${entry}`;
      if (entry === name) found.push(r);
      else if (statSync(abs).isDirectory()) walk(abs, r, depth + 1);
    }
  };
  walk(repoDir, "", 0);
  return found;
}

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

/** Deterministic component skeleton: anchors the agent refine + the command ladder. */
export function detectComponents(repoDir: string): {
  components: Component[];
  repoCommands: Record<string, string>;
} {
  const components: Component[] = [];

  // --- Rust: collapse a workspace into one component; else one per standalone Cargo.toml.
  const cargoRoot = join(repoDir, "Cargo.toml");
  const workspaceMembers = existsSync(cargoRoot) ? cargoWorkspaceMembers(cargoRoot) : null;
  if (workspaceMembers) {
    const collapsed = collapseWorkspaceGlobs(workspaceMembers);
    const paths = ["Cargo.toml", "Cargo.lock", ...collapsed];
    components.push({
      name: "rust-core",
      kind: "rust",
      paths,
      commands: { build: "cargo build --workspace", test: "cargo test --workspace" },
    });
  } else {
    for (const rel of findManifests(repoDir, "Cargo.toml")) {
      const dir = rel.replace(/Cargo\.toml$/, "").replace(/\/$/, "");
      components.push({
        name: dir === "" ? "rust" : dir.replace(/\//g, "-"),
        kind: "rust",
        paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "cargo build", test: "cargo test" },
      });
    }
  }

  // --- Node/JS: one component per package.json (skip workspace-member packages already covered).
  for (const rel of findManifests(repoDir, "package.json")) {
    const dir = rel.replace(/package\.json$/, "").replace(/\/$/, "");
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(repoDir, rel), "utf8")) as {
        scripts?: Record<string, string>;
      };
    } catch {
      // Malformed package.json — skip this component rather than crashing styre setup.
      continue;
    }
    const scripts = pkg.scripts ?? {};
    const commands: Component["commands"] = {};
    if (scripts.build) commands.build = "npm run build";
    if (scripts.test) commands.test = "npm run test";
    if (scripts.check) commands.check = "npm run check";
    const isRoot = dir === "";
    const fe =
      existsSync(join(repoDir, "svelte.config.js")) || existsSync(join(repoDir, "vite.config.js"));
    components.push({
      name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
      kind: isRoot && fe ? "sveltekit" : "node",
      // Co-located frontend: root package.json owns src/static, NOT a sibling rust src-tauri.
      paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
      commands,
    });
  }

  return { components, repoCommands: {} };
}
