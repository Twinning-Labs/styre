import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../../dispatch/profile.ts";
import type { LangDef } from "./types.ts";

export const goDef: LangDef = {
  kind: "go",
  detect(repoDir: string): Component[] {
    if (!existsSync(join(repoDir, "go.mod"))) return [];
    return [
      {
        name: "go",
        kind: "go",
        paths: ["**"],
        commands: { build: "go build ./...", test: "go test ./..." },
      },
    ];
  },
};
