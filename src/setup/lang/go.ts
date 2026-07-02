import { findManifests } from "../manifests.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

export const goDef: LangDef = {
  kind: "go",
  detect(repoDir: string): ComponentDraft[] {
    const out: ComponentDraft[] = [];
    for (const rel of findManifests(repoDir, "go.mod")) {
      const dir = rel.slice(0, -"go.mod".length).replace(/\/$/, "");
      out.push({
        name: dir === "" ? "go" : dir.replace(/\//g, "-"),
        kind: "go",
        ...(dir === "" ? {} : { dir }),
        paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "go build ./...", test: "go test ./..." },
      });
    }
    return out;
  },
};
