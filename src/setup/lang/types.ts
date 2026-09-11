import type { Component } from "../../dispatch/profile.ts";

/** A detected component before the engine attaches `extensions` (materialized from `EXTENSIONS_BY_KIND`).
 *  Detector implementations return this; the engine promotes to `Component` via `runRegistry`.
 *
 *  `role` (ENG-425) is optional on `Component` and so optional here: the deterministic scan
 *  cannot tell a fixture package from a real one — that judgment belongs to the discovery agent,
 *  which reads the repo. A detector that says nothing leaves it absent, which reads as primary. */
export type ComponentDraft = Omit<Component, "extensions">;

export interface LangDef {
  kind: string;
  detect(repoDir: string): ComponentDraft[];
}
