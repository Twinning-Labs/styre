import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../../dispatch/profile.ts";
import { findManifests } from "../manifests.ts";
import { nodeInstall, nodeManager } from "../node-manager.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

export function nodePrepare(compDir: string, repoDir = compDir): string | undefined {
  const selection = nodeManager(repoDir, compDir);
  if (
    selection.manager === "npm" &&
    existsSync(join(repoDir, selection.workspaceDir, "package-lock.json"))
  )
    return "npm ci";
  return nodeInstall(selection);
}

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
        throw new Error(
          `setup: invalid package.json at ${rel}; cannot determine this component's test environment`,
        );
      }
      const scripts = pkg.scripts ?? {};
      const manager = nodeManager(repoDir, join(repoDir, dir));
      const pm = manager.manager;
      const commands: Component["commands"] = {};
      if (scripts.build && pm) commands.build = `${pm} run build`;
      const suites = Object.keys(scripts).filter(
        (name) => /^test(?::[A-Za-z0-9:._-]+)?$/.test(name) && typeof scripts[name] === "string",
      );
      const selected = scripts.test ? "test" : suites.length === 1 ? suites[0] : undefined;
      if (selected && pm) commands.test = `${pm} run ${selected}`;
      else
        commands.test = {
          unresolved:
            manager.reason ??
            (suites.length > 1
              ? `Multiple test scripts (${suites.join(", ")}); select the intended suite.`
              : "No declared test script; configure a test-authoring workflow or explicitly mark testing unavailable."),
        };
      if (scripts.check && pm) commands.check = `${pm} run check`;
      const isRoot = dir === "";
      const fe =
        existsSync(join(repoDir, "svelte.config.js")) ||
        existsSync(join(repoDir, "vite.config.js"));
      components.push({
        name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
        kind: isRoot && fe ? "sveltekit" : "node",
        ...(isRoot ? {} : { dir }),
        // Co-located frontend: root package.json owns src/static, NOT a sibling rust src-tauri.
        paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
        commands,
        prepare: nodePrepare(isRoot ? repoDir : join(repoDir, dir), repoDir),
      });
    }
    return components;
  },
};
