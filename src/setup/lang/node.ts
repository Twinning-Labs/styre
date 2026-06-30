import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../../dispatch/profile.ts";
import { findManifests } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

export const nodeDef: LangDef = {
  kind: "node",
  detect(repoDir: string): ComponentDraft[] {
    const components: ComponentDraft[] = [];
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
        existsSync(join(repoDir, "svelte.config.js")) ||
        existsSync(join(repoDir, "vite.config.js"));
      components.push({
        name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
        kind: isRoot && fe ? "sveltekit" : "node",
        // Co-located frontend: root package.json owns src/static, NOT a sibling rust src-tauri.
        paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
        commands,
        prepare: "npm install",
      });
    }
    return components;
  },
};
