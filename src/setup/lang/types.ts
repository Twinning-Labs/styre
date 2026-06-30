import type { Component } from "../../dispatch/profile.ts";

/** A detected component before the engine attaches `extensions` (materialized from `EXTENSIONS_BY_KIND`).
 *  Detector implementations return this; the engine promotes to `Component` via `runRegistry`. */
export type ComponentDraft = Omit<Component, "extensions">;

export interface LangDef {
  kind: string;
  detect(repoDir: string): ComponentDraft[];
}
