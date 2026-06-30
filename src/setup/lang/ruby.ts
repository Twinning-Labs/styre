import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../../dispatch/profile.ts";
import type { ComponentDraft, LangDef } from "./types.ts";

/** Signal-gated test command ladder.
 *  rspec → rake → {unavailable} (never fabricates a vacuous gate — operator decision). */
export function rubyTestCommand(repoDir: string): Component["commands"] {
  if (existsSync(join(repoDir, ".rspec")) || existsSync(join(repoDir, "spec")))
    return { test: "bundle exec rspec" };
  if (existsSync(join(repoDir, "Rakefile"))) return { test: "bundle exec rake test" };
  return { test: { unavailable: true } }; // no signal → surfaces untested-merge-risk at verify
}

export const rubyDef: LangDef = {
  kind: "ruby",
  detect(repoDir: string): ComponentDraft[] {
    if (!existsSync(join(repoDir, "Gemfile"))) return [];
    return [
      {
        name: "ruby",
        kind: "ruby",
        paths: ["**"],
        commands: rubyTestCommand(repoDir),
        testFilePattern: "_(test|spec)\\.rb$",
        prepare: "bundle install",
      },
    ];
  },
};
