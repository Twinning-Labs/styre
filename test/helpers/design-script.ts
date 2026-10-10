import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.ts";

/** The agent steps a design run can reach, recognised by the first line of their prompt template. */
export const SCRIPT_STEPS = [
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
  "checks:dispatch",
  "implement",
  "review",
] as const;
export type ScriptStep = (typeof SCRIPT_STEPS)[number];

const MARKERS: ReadonlyArray<readonly [string, ScriptStep]> = [
  ["You are designing ticket", "design:dispatch"],
  ["You are extracting the work breakdown", "design:extract"],
  ["You are grading the COMPLEXITY", "design:size"],
  ["You are the independent plan reviewer", "design:review"],
  ["You are authoring acceptance checks", "checks:dispatch"],
  ["You are implementing work-unit", "implement"],
  ["You are the independent code reviewer", "review"],
];

export function stepOfPrompt(prompt: string): ScriptStep {
  for (const [marker, step] of MARKERS) if (prompt.includes(marker)) return step;
  throw new Error(`design script: unrecognised prompt: ${prompt.slice(0, 120)}`);
}

export interface ScriptUnit {
  seq: number;
  kind: string;
  title: string;
  description: string;
  behavioral: boolean;
  test_plan: string | null;
  files_to_touch: string[];
  verify_check_types: string[];
  depends_on: number[];
}

export interface ScriptFinding {
  severity: "critical" | "major" | "minor" | "nit";
  category: string;
  location: string | null;
  rationale: string;
  factors: null;
  deferral_candidate: boolean;
  work_unit_seq: number | null;
}

export interface DesignScript {
  ident: string;
  /** Plan body for the n-th design:dispatch call (1-based, counted across the whole harness). */
  plan: (call: number) => string;
  /** Plan file name under docs/plans/ for the n-th call. */
  planFile: (call: number) => string;
  /** Remove the other docs/plans/*.md files first, so a new planFile is a rename. */
  renamePlan: boolean;
  units: (call: number) => ScriptUnit[];
  grade: (call: number) => number;
  planFindings: (call: number) => ScriptFinding[];
  /** This step gets a session-limit result: on the `parkOnCall`-th call (counted across the
   *  harness), or, when that is null, on the first prompt of the step that reaches this runner. */
  parkAt: ScriptStep | null;
  parkOnCall: number | null;
}

export interface ScriptCalls {
  counts: Record<ScriptStep, number>;
  prompts: Array<{ step: ScriptStep; prompt: string }>;
}

export function newCalls(): ScriptCalls {
  return {
    counts: Object.fromEntries(SCRIPT_STEPS.map((s) => [s, 0])) as Record<ScriptStep, number>,
    prompts: [],
  };
}

/** `n` units. Behavioural units carry their own test file (validateExtraction requires it), so the
 *  checks step finds work it cannot verify and pauses the run (`needs_you`) right after design. */
export function unitsOf(
  n: number,
  opts: { behavioral: boolean; dir?: string; ext?: string; titleSuffix?: string },
): ScriptUnit[] {
  const dir = opts.dir ?? "lib";
  const ext = opts.ext ?? "rb";
  return Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    const code = `${dir}/u${seq}.${ext}`;
    const test = ext === "rb" ? `test/u${seq}_test.rb` : `${dir}/u${seq}.test.${ext}`;
    return {
      seq,
      kind: "backend",
      title: `Unit ${seq}${opts.titleSuffix ?? ""}`,
      description: `Change ${seq}`,
      behavioral: opts.behavioral,
      test_plan: opts.behavioral ? `${test} asserts change ${seq}` : null,
      files_to_touch: opts.behavioral ? [code, test] : [code],
      verify_check_types: opts.behavioral ? ["test"] : [],
      depends_on: [],
    };
  });
}

export function defaultScript(overrides: Partial<DesignScript> = {}): DesignScript {
  return {
    ident: "ENG-1",
    plan: () => "Plan body, version 1",
    planFile: () => "eng-1-plan.md",
    renamePlan: false,
    units: () => unitsOf(2, { behavioral: true }),
    grade: () => 6,
    planFindings: () => [],
    parkAt: null,
    parkOnCall: null,
    ...overrides,
  };
}

export const sidecar = (value: unknown): string =>
  `Done.\n\n\`\`\`styre-sidecar\n${JSON.stringify(value)}\n\`\`\`\n`;

/** Every CDOT section addressed and none applying, so extraction passes `validateCdotImpact` under
 *  any runtime context, including a profile that leaves it at its default (`unknown` presence,
 *  which requires an analysis). `documentation.applies` is false, so `needs_docs` stays 0. */
export const ADDRESSED_CDOT = {
  data: { applies: false, analysis: "not affected", schemaChange: false },
  caching: { applies: false, analysis: "not affected" },
  observability: { applies: false, analysis: "not affected" },
  configSecrets: { applies: false, analysis: "not affected" },
  documentation: { applies: false, analysis: "not affected" },
};

const ok = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});

const sessionLimit = (): AgentRunResult => ({
  completed: false,
  exitCode: 1,
  stdout: "partial output written before the session limit",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});

/** A FakeAgentRunner that plays each design step from `script` and counts every call in `calls`. */
export function scriptedRunner(script: DesignScript, calls: ScriptCalls): FakeAgentRunner {
  let parked = false;
  return new FakeAgentRunner((input: AgentRunInput) => {
    const step = stepOfPrompt(input.prompt);
    calls.counts[step] += 1;
    calls.prompts.push({ step, prompt: input.prompt });
    const n = calls.counts[step];
    if (
      script.parkAt === step &&
      (script.parkOnCall === null ? !parked : n === script.parkOnCall)
    ) {
      parked = true;
      return sessionLimit();
    }
    switch (step) {
      case "design:dispatch": {
        const plans = join(input.cwd, "docs", "plans");
        mkdirSync(plans, { recursive: true });
        if (script.renamePlan) {
          for (const f of readdirSync(plans)) if (f.endsWith(".md")) rmSync(join(plans, f));
        }
        writeFileSync(
          join(plans, script.planFile(n)),
          `---\nlinear: ${script.ident}\n---\n\n${script.plan(n)}\n`,
        );
        return ok("Plan written.");
      }
      case "design:extract":
        return ok(sidecar({ units: script.units(n), cdotImpact: ADDRESSED_CDOT }));
      case "design:size":
        return ok(
          sidecar({
            dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 },
            overall: script.grade(n),
          }),
        );
      case "design:review":
        return ok(sidecar({ findings: script.planFindings(n) }));
      case "implement": {
        const seq = Number(input.prompt.match(/You are implementing work-unit (\d+)/)?.[1]);
        const unit = script
          .units(Math.max(1, calls.counts["design:extract"]))
          .find((u) => u.seq === seq);
        if (!unit) throw new Error(`design script: no unit ${seq} to implement`);
        const created: string[] = [];
        for (const f of unit.files_to_touch) {
          const p = join(input.cwd, f);
          if (existsSync(p)) appendFileSync(p, `# implement call ${n}\n`);
          else {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, `# unit ${seq}, implement call ${n}\n`);
            created.push(f);
          }
        }
        return ok(sidecar({ new_files: created }));
      }
      case "review":
        return ok(sidecar({ findings: [] }));
      case "checks:dispatch":
        throw new Error(
          "design script: checks:dispatch is not scripted (no runnable check framework)",
        );
    }
  });
}

export const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

/** One Ruby component whose commands are `true`: provision installs nothing, the toolchain probe
 *  passes, and no check framework resolves, so behavioural work pauses at checks:dispatch. */
export function harnessProfileRaw(repo: string, slug = "harness"): Record<string, unknown> {
  return {
    slug,
    targetRepo: repo,
    defaultBranch: "main",
    checksSystem: "none",
    components: [
      {
        name: "app",
        kind: "ruby",
        paths: ["**"],
        commands: { build: "true", test: "true", check: "true" },
      },
    ],
    promptVars: { stack: "ruby" },
    runtimeContext: ABSENT_RC,
  };
}
