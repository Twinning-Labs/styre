import type { Component } from "../../dispatch/profile.ts";
export interface LangDef {
  kind: string;
  detect(repoDir: string): Component[];
}
