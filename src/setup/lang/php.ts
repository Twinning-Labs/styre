import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentDraft, LangDef } from "./types.ts";

/** True if the repo uses Pest:
 *  - `tests/Pest.php` exists (config-file signal), OR
 *  - `composer.json` has `pestphp/pest` in `require` or `require-dev`.
 *  Malformed composer.json → return false (falls through to phpunit).
 *  The `existsSync(composer.json)` gate in `phpDef.detect` is independent,
 *  so a malformed file still causes the PHP component to be emitted. */
function usesPest(repoDir: string): boolean {
  if (existsSync(join(repoDir, "tests", "Pest.php"))) return true;
  try {
    const j = JSON.parse(readFileSync(join(repoDir, "composer.json"), "utf8"));
    return Boolean(j.require?.["pestphp/pest"] ?? j["require-dev"]?.["pestphp/pest"]);
  } catch {
    return false;
  }
}

export const phpDef: LangDef = {
  kind: "php",
  detect(repoDir: string): ComponentDraft[] {
    if (!existsSync(join(repoDir, "composer.json"))) return [];
    return [
      {
        name: "php",
        kind: "php",
        paths: ["**"],
        commands: { test: usesPest(repoDir) ? "./vendor/bin/pest" : "./vendor/bin/phpunit" },
        // Anchored to tests?/ dir: A1 only credits a *Test.php that bare
        // phpunit/pest actually discovers (inside tests/ or test/).
        // A co-located test (e.g. src/CalculatorTest.php) fails A1 loud
        // rather than passing vacuously when phpunit never ran it.
        testFilePattern: "(^|/)tests?/.*Test\\.php$",
        prepare: "composer install",
      },
    ];
  },
};
