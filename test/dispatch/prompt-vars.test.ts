import { expect, test } from "bun:test";
import type { WorkUnitRow } from "../../src/db/repos/work-unit.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import {
  CHECKS_TEMPLATE,
  DESIGN_REVIEW_TEMPLATE,
  DESIGN_TEMPLATE,
  EXTRACT_TEMPLATE,
  IMPLEMENT_TEMPLATE,
  REVIEW_TEMPLATE,
  checksVars,
  designReviewVars,
  designVars,
  extractVars,
  implementVars,
  reviewVars,
  stackSummary,
} from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/demo",
  components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
  promptVars: { stack: "Bun + SQLite" },
});
const ticket = { ident: "ENG-9", title: "Add widget", description: "Add a widget feature" };
const unit = {
  seq: 2,
  kind: "backend",
  title: "API",
  files_to_touch: null,
} as unknown as WorkUnitRow;

test("designVars resolves every placeholder in the design template", () => {
  const vars = designVars(ticket, profile);
  expect(renderPrompt(DESIGN_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(DESIGN_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("implementVars resolves every placeholder in the implement template", () => {
  const vars = implementVars(ticket, unit, profile);
  expect(renderPrompt(IMPLEMENT_TEMPLATE, vars).ok).toBe(true);
  for (const name of placeholders(IMPLEMENT_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("extract template renders with extractVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });
  const r = renderPrompt(EXTRACT_TEMPLATE, extractVars({ ident: "ENG-1", title: "T" }, profile));
  expect(r.ok).toBe(true);
});

test("implementVars carries the feedback var (empty by default)", () => {
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/r",
    components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "bun test" } }],
  });
  const ticket = { ident: "ENG-1", title: "T" };
  const unit = {
    seq: 1,
    kind: "backend",
    title: "U",
    files_to_touch: null,
  } as unknown as WorkUnitRow;
  expect(implementVars(ticket, unit, profile).feedback).toBe("");
  expect(implementVars(ticket, unit, profile, "fix the build").feedback).toBe("fix the build");
});

test("implementVars threads reviewFeedbackText into the review_feedback var", () => {
  const vars = implementVars(ticket, unit, profile, "", [], "", "REVIEWMARKER");
  expect(vars.review_feedback).toBe("REVIEWMARKER");
});

// STYRE-7 Fix B: implement is shown its declared Channel-A scope (was gated against a list it never saw).
test("implementVars surfaces files_to_touch as a floor, not a cage", () => {
  const behavioral = {
    seq: 1,
    kind: "backend",
    title: "iCal serializer",
    test_plan: "assert exact calendar properties",
    files_to_touch: JSON.stringify(["src/ical.php", "tests/Unit/IcsTest.php"]),
  } as unknown as WorkUnitRow;
  const vars = implementVars(ticket, behavioral, profile);
  expect(vars.files_to_touch).toContain("src/ical.php");
  expect(vars.files_to_touch).toContain("tests/Unit/IcsTest.php");
  // Floor-not-cage wording — must NOT read as an allowlist (guards against re-importing the A3 hard gate).
  expect(vars.files_to_touch).toContain("at least");
  expect(vars.files_to_touch.toLowerCase()).toContain("may touch other files");
  expect(vars.test_plan).toContain("assert exact calendar properties");
});

test("implementVars tells implement the authored checks read red until satisfied", () => {
  const withChecks = implementVars(ticket, unit, profile, "", [
    { test_path: "tests/styre_checks/ENG-9_ac1_test.ts" },
  ]);
  expect(withChecks.authored_checks).toContain("tests/styre_checks/ENG-9_ac1_test.ts");
  expect(withChecks.authored_checks).toContain("red");
  expect(withChecks.authored_checks).toContain("expected and is not a bug");
  // No authored checks ⇒ no section at all (no orphan expected-red note).
  expect(implementVars(ticket, unit, profile).authored_checks).toBe("");
});

test("implementVars omits the test_plan section for a unit without one", () => {
  const nonBehavioral = {
    seq: 1,
    kind: "docs",
    title: "readme",
    test_plan: null,
    files_to_touch: JSON.stringify(["README.md"]),
  } as unknown as WorkUnitRow;
  const vars = implementVars(ticket, nonBehavioral, profile);
  expect(vars.test_plan).toBe("");
  expect(vars.files_to_touch).toContain("README.md");
});

test("implementVars review_feedback defaults to empty", () => {
  expect(implementVars(ticket, unit, profile).review_feedback).toBe("");
});

test("implement prompt has a review_feedback slot", () => {
  expect(IMPLEMENT_TEMPLATE).toContain("{{review_feedback}}");
});

test("implementVars renders the authored check paths + a do-not-edit instruction", () => {
  const vars = implementVars(ticket, unit, profile, "", [
    { test_path: "api/tests/styre_checks/ENG-1_ac7_test.py" },
  ]);
  expect(vars.authored_checks).toContain("ENG-1_ac7_test.py");
  expect(vars.authored_checks.toLowerCase()).toContain("do not edit");
});

test("implementVars with no authored checks renders an empty slot", () => {
  expect(implementVars(ticket, unit, profile, "", []).authored_checks).toBe("");
});

test("review template renders with reviewVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });
  const r = renderPrompt(REVIEW_TEMPLATE, reviewVars({ ident: "ENG-1", title: "T" }, profile));
  expect(r.ok).toBe(true);
  for (const name of placeholders(REVIEW_TEMPLATE)) {
    expect(name in reviewVars({ ident: "ENG-1", title: "T" }, profile)).toBe(true);
  }
});

test("design-review template renders with designReviewVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x" });
  const r = renderPrompt(
    DESIGN_REVIEW_TEMPLATE,
    designReviewVars({ ident: "ENG-1", title: "T" }, profile),
  );
  expect(r.ok).toBe(true);
  for (const name of placeholders(DESIGN_REVIEW_TEMPLATE)) {
    expect(name in designReviewVars({ ident: "ENG-1", title: "T" }, profile)).toBe(true);
  }
});

test("extractVars surfaces runtime-context flags + detail", () => {
  const profile = parseProfile({
    slug: "d",
    targetRepo: "/t",
    runtimeContext: {
      data: { presence: "present", detail: "postgres/prisma", migrationTool: "prisma" },
    },
  });
  const v = extractVars({ ident: "ENG-1", title: "t" }, profile);
  expect(v.runtime_data_presence).toBe("present");
  expect(v.runtime_data_detail).toBe("postgres/prisma");
  expect(v.runtime_data_migration_tool).toBe("prisma");
  expect(v.runtime_caching_presence).toBe("unknown");
});

test("designVars also carries runtime vars", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t" });
  const v = designVars({ ident: "ENG-1", title: "t", description: "" }, profile);
  expect(v.runtime_documentation_presence).toBe("unknown");
});

test("implementVars sources test_command from the unit's impacted components", () => {
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/r",
    components: [
      { name: "rust", kind: "rust", paths: ["src-tauri/**"], commands: { test: "cargo test" } },
      {
        name: "fe",
        kind: "sveltekit",
        paths: ["src/**"],
        commands: { test: { unavailable: true } },
      },
    ],
  });
  // implementVars only reads seq/kind/title/files_to_touch; cast the partial literal to WorkUnitRow.
  const unit = {
    seq: 1,
    kind: "backend",
    title: "x",
    files_to_touch: JSON.stringify(["src-tauri/lib.rs"]),
  } as unknown as WorkUnitRow;
  const vars = implementVars({ ident: "ENG-1", title: "t" }, unit, profile);
  expect(vars.test_command).toBe("cargo test");
});

const COMPS: Component[] = [
  { name: "go", kind: "go", paths: ["**"], commands: { test: "go test ./..." }, extensions: [] },
  {
    name: "frontend",
    kind: "sveltekit",
    paths: ["src/**", "static/**", "package.json"],
    commands: { test: "npm run test" },
    extensions: [],
  },
];

test("stackSummary is empty for no components; lists kind/name/paths/test otherwise", () => {
  expect(stackSummary([])).toBe("");
  const s = stackSummary(COMPS);
  expect(s).toContain("go");
  expect(s).toContain("sveltekit");
  expect(s).toContain("go test ./...");
  expect(s).toContain("src/**");
  // pin the rendered line shape (a format regression guard, not just substrings)
  expect(s.split("\n")[0]).toBe("- go (kind: go) — paths: **; test: go test ./...");
  // the `; test: …` segment is omitted when the component has no (or an unavailable) test command
  expect(
    stackSummary([{ name: "x", kind: "go", paths: ["**"], commands: {}, extensions: [] }]),
  ).toBe("- x (kind: go) — paths: **");
});

test("designVars + extractVars carry detected_stacks from the profile components", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t", components: COMPS });
  const dv = designVars({ ident: "ENG-1", title: "T", description: "b" }, profile);
  const ev = extractVars({ ident: "ENG-1", title: "T" }, profile);
  expect(dv.detected_stacks).toBe(stackSummary(COMPS));
  expect(ev.detected_stacks).toBe(stackSummary(COMPS));
  expect(dv.detected_stacks).toContain("sveltekit");
  expect(dv.stack).toBe(""); // {{stack}} (free-text note) unchanged; no promptVars.stack in this fixture
});

test("detected_stacks falls back to a no-detect note when the profile has no components", () => {
  const profile = parseProfile({ slug: "d", targetRepo: "/t" });
  const v = extractVars({ ident: "E", title: "T" }, profile).detected_stacks;
  expect(v).toContain("no stacks auto-detected");
  expect(stackSummary([])).toBe(""); // the pure helper still returns "" — the fallback is var-level
});

test("design template has a review_feedback slot", () => {
  expect(placeholders(DESIGN_TEMPLATE)).toContain("review_feedback");
});

test("designVars fills review_feedback (empty default renders cleanly)", () => {
  expect(renderPrompt(DESIGN_TEMPLATE, designVars(ticket, profile)).ok).toBe(true); // "" fills the slot
  const r = renderPrompt(
    DESIGN_TEMPLATE,
    designVars(ticket, profile, "PRIOR REVIEW: fix the regex"),
  );
  expect(r.ok && r.prompt.includes("PRIOR REVIEW: fix the regex")).toBe(true);
});

test("checksVars fills every placeholder in the checks template (no CL-PROFILE miss)", () => {
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/r",
    components: [
      { name: "api", kind: "python", paths: ["api/**"], commands: { test: "pytest -q" } },
    ],
  });
  const vars = checksVars({ ident: "ENG-1", title: "T" }, profile, [
    { id: 7, text: "returns 200 on GET /health" },
    { id: 8, text: "rejects an unauthenticated request" },
  ]);
  const rendered = renderPrompt(CHECKS_TEMPLATE, vars);
  expect(rendered.ok).toBe(true);
  if (rendered.ok) {
    expect(rendered.prompt).toContain("ac_id=7");
    expect(rendered.prompt).toContain("returns 200 on GET /health");
    expect(rendered.prompt).toContain("api (kind: python)");
  }
});

test("implement prompt instructs new_files declaration + scratch prevention", () => {
  expect(IMPLEMENT_TEMPLATE).toContain("new_files");
  expect(IMPLEMENT_TEMPLATE.toLowerCase()).toContain("do not leave");
  expect(IMPLEMENT_TEMPLATE).toContain("```styre-sidecar");
  // scratch goes in the swept styre_scratch/ drawer (ENG-300), not /tmp
  expect(IMPLEMENT_TEMPLATE).toContain("styre_scratch/");
});
