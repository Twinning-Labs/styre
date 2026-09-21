import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { TestEnvironmentPlan } from "./environment-schema.ts";
import { KarmaCompletionSchema, karmaReporterConfig, karmaVerdict } from "./karma.ts";

export const SuiteBindingSchema = z
  .object({
    protocol: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SuiteBinding = z.infer<typeof SuiteBindingSchema>;
export const SuiteReceiptSchema = z
  .object({
    version: z.literal(1),
    binding: SuiteBindingSchema,
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z.enum(["process", "structured"]),
    verdict: z.enum(["pass", "fail", "error"]),
    payload: z.unknown(),
  })
  .strict();
export type SuiteReceipt = z.infer<typeof SuiteReceiptSchema>;
type ProcessOutcome = { exitCode: number | null; timedOut: boolean };
type Verdict = "pass" | "fail" | "error";
interface SuiteAdapter {
  evidence: "process" | "structured";
  validateParameters: (parameters: unknown) => boolean;
  prepare: (
    command: string,
    cwd: string,
    binding: SuiteBinding,
  ) => {
    command: string;
    read: () => unknown;
    cleanup: () => void;
  };
  verdict: (payload: unknown, run: ProcessOutcome, parameters: Record<string, unknown>) => Verdict;
}
const processAdapter: SuiteAdapter = {
  evidence: "process",
  validateParameters: (p) => z.object({}).strict().safeParse(p).success,
  prepare: (command) => ({ command, read: () => null, cleanup: () => {} }),
  verdict: (payload, run) =>
    payload !== null || run.timedOut || run.exitCode === null
      ? "error"
      : run.exitCode === 0
        ? "pass"
        : "fail",
};
const KarmaParametersSchema = z
  .object({
    browsers: z
      .array(z.enum(["Firefox", "FirefoxHeadless", "Chrome", "ChromeHeadless"]))
      .min(1)
      .max(16)
      .refine((xs) => new Set(xs).size === xs.length),
  })
  .strict();
const karmaAdapter: SuiteAdapter = {
  evidence: "structured",
  validateParameters: (p) => KarmaParametersSchema.safeParse(p).success,
  prepare: (command, cwd, binding) => {
    const parameters = KarmaParametersSchema.parse(binding.parameters);
    const dir = mkdtempSync(join(tmpdir(), "styre-karma-"));
    const reportPath = join(dir, "completion.json");
    const wrapper = join(dir, "config.cjs");
    try {
      writeFileSync(
        wrapper,
        karmaReporterConfig(
          cwd,
          {
            version: 1,
            adapter: "karma",
            policy: "existing",
            suiteCommand: command,
            workspaceDir: ".",
            manager: "npm",
            configFile: "karma.conf.js",
            browsers: parameters.browsers,
          },
          reportPath,
        ),
        { mode: 0o600 },
      );
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return {
      command: `${command} -- --single-run=true '${wrapper.replace(/'/g, `'\\''`)}'`,
      read: () => {
        try {
          if (statSync(reportPath).size > 65536) return null;
          return JSON.parse(readFileSync(reportPath, "utf8"));
        } catch {
          return null;
        } // missing/malformed reporter evidence is an explicit error verdict
      },
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  verdict: (payload, run, parameters) =>
    run.timedOut
      ? "error"
      : karmaVerdict(
          payload,
          run.exitCode,
          KarmaParametersSchema.parse(parameters).browsers.length,
        ),
};

/** Versioned protocols are selected only here, never by dispatch or evidence-floor code. */
const adapters: Record<string, SuiteAdapter> = {
  "process-v1": processAdapter,
  "karma-v1": karmaAdapter,
};
export function suiteBinding(plan?: TestEnvironmentPlan): SuiteBinding {
  if (plan?.adapter === "unsupported") throw Error(plan.reason);
  if (plan?.adapter === "karma")
    return { protocol: "karma-v1", parameters: { browsers: plan.browsers } };
  if (!plan || plan.adapter === "python" || plan.adapter === "node")
    return { protocol: "process-v1", parameters: {} };
  throw Error("No suite adapter is registered for this environment");
}
function adapterFor(binding: SuiteBinding): SuiteAdapter {
  const adapter = Object.hasOwn(adapters, binding.protocol)
    ? adapters[binding.protocol]
    : undefined;
  if (!adapter || !adapter.validateParameters(binding.parameters))
    throw Error("Unsupported or malformed suite evidence protocol");
  return adapter;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function suiteContractHash(command: string, cwd: string, binding: SuiteBinding): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ command, cwd, binding })))
    .digest("hex");
}
export function prepareSuite(command: string, cwd: string, binding: SuiteBinding) {
  return adapterFor(binding).prepare(command, cwd, binding);
}
export function suiteReceipt(
  command: string,
  cwd: string,
  binding: SuiteBinding,
  payload: unknown,
  run: ProcessOutcome,
): SuiteReceipt {
  const adapter = adapterFor(binding);
  return {
    version: 1,
    binding,
    contractHash: suiteContractHash(command, cwd, binding),
    evidence: adapter.evidence,
    verdict: adapter.verdict(payload, run, binding.parameters),
    payload,
  };
}
/** Recompute from raw evidence; never authorize a stored or agent-reported verdict by itself. */
export function receiptVerdict(
  value: unknown,
  command: string,
  cwd: string,
  run: ProcessOutcome,
  expected?: SuiteBinding,
): Verdict {
  const parsed = SuiteReceiptSchema.safeParse(value);
  if (!parsed.success) return "error";
  const receipt = parsed.data;
  try {
    const binding = expected ?? receipt.binding;
    const adapter = adapterFor(binding);
    if (
      suiteContractHash(command, cwd, binding) !== receipt.contractHash ||
      suiteContractHash(command, cwd, receipt.binding) !== receipt.contractHash ||
      adapter.evidence !== receipt.evidence
    )
      return "error";
    const verdict = adapter.verdict(receipt.payload, run, binding.parameters);
    return verdict === receipt.verdict ? verdict : "error";
  } catch {
    return "error";
  }
}

/** Read-only legacy protocol: old structured checkpoints stay inspectable, never become process passes. */
export const LegacySuiteEvidenceSchema = z.object({
  verdict: z.enum(["pass", "fail", "error"]),
  completion: KarmaCompletionSchema.optional(),
  reason: z.string().optional(),
});
export function legacySuiteVerdict(value: unknown, run: ProcessOutcome): Verdict {
  const parsed = LegacySuiteEvidenceSchema.safeParse(value);
  if (!parsed.success || run.timedOut) return "error";
  const r = parsed.data;
  const verdict = karmaVerdict(r.completion, run.exitCode, r.completion?.browsers.length ?? 0);
  return verdict === r.verdict ? verdict : "error";
}
