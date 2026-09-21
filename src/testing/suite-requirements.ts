import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { GroundTruthSignalRow } from "../db/repos/ground-truth-signal.ts";
import type { Component } from "../dispatch/profile.ts";
import { SuiteObservationSchema } from "../dispatch/suite-observation.ts";
import { suiteRequirement } from "./capabilities.ts";
import { TestEnvironmentPlanSchema } from "./environment-schema.ts";
import { SuiteBindingSchema, receiptVerdict, suiteBinding } from "./suite-adapters.ts";

export const SuiteRequirementSchema = z
  .object({
    label: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    binding: SuiteBindingSchema,
    environment: TestEnvironmentPlanSchema.optional(),
  })
  .strict();
export const SuiteRequirementsSchema = z
  .object({
    version: z.literal(1),
    requirements: z
      .array(SuiteRequirementSchema)
      .refine(
        (xs) => new Set(xs.map((x) => x.label)).size === xs.length,
        "Duplicate required suite label",
      ),
  })
  .strict();
export type SuiteRequirements = z.infer<typeof SuiteRequirementsSchema>;
export function declaredSuiteRequirements(
  components: Component[],
  worktree: string,
): SuiteRequirements {
  if (new Set(components.map((c) => c.name)).size !== components.length)
    throw Error("Duplicate component names cannot identify suite evidence");
  return SuiteRequirementsSchema.parse({
    version: 1,
    requirements: components
      .filter((c) => suiteRequirement(c) === "required")
      .map((c) => {
        const command = c.commands.test;
        if (typeof command !== "string" || !command.trim())
          throw Error(`Required suite ${c.name} has no executable test command`);
        if (c.testEnvironment && c.testEnvironment.suiteCommand !== command)
          throw Error(`Required suite ${c.name} differs from its environment contract`);
        return {
          label: `${c.name}:test`,
          command,
          cwd: join(worktree, c.dir ?? ""),
          binding: suiteBinding(c.testEnvironment),
          ...(c.testEnvironment ? { environment: c.testEnvironment } : {}),
        };
      }),
  });
}
export function requirementsHash(contract: SuiteRequirements): string {
  return createHash("sha256")
    .update(JSON.stringify(SuiteRequirementsSchema.parse(contract)))
    .digest("hex");
}
function detail(row?: GroundTruthSignalRow): Record<string, unknown> | null {
  try {
    const d = JSON.parse(row?.detail_json ?? "null");
    return d && typeof d === "object" && !Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

/** Used after requiredSuiteProblem at publication boundaries. Invalid declarations never weaken policy. */
export function hasRequiredSuites(signals: GroundTruthSignalRow[]): boolean {
  const declaration = signals
    .filter((s) => s.signal_type === "suite-requirements" && s.work_unit_id === null)
    .at(-1);
  if (!declaration) return false;
  const parsed = SuiteRequirementsSchema.safeParse(detail(declaration));
  return declaration.result !== "pass" || !parsed.success || parsed.data.requirements.length > 0;
}

/** Expected obligations are a separate runner-written signal, never inferred from a run report. */
export function requiredSuiteProblem(
  signals: GroundTruthSignalRow[],
  head: string | null,
): string | undefined {
  const declaration = signals
    .filter((s) => s.signal_type === "suite-requirements" && s.work_unit_id === null)
    .at(-1);
  const integration = signals
    .filter(
      (s) =>
        s.signal_type === "integration" && s.work_unit_id === null && s.branch_head_sha === head,
    )
    .at(-1);
  const reported = detail(integration);
  if (!declaration) {
    // Legacy process ledgers remain readable. Legacy required-suite claims lack an independent
    // expected contract and must be rerun, not silently upgraded to qualified receipts.
    if (
      reported &&
      (Object.hasOwn(reported, "suiteRequirementsHash") ||
        (Array.isArray(reported.ran) &&
          reported.ran.some((j) => j?.observation && Object.hasOwn(j.observation, "suite"))) ||
        (Object.hasOwn(reported, "requiredSuites") &&
          (!Array.isArray(reported.requiredSuites) || reported.requiredSuites.length > 0)))
    )
      return "Required suites lack an independent declaration; rerun verification.";
    return;
  }
  const parsed = SuiteRequirementsSchema.safeParse(detail(declaration));
  if (!parsed.success || declaration.result !== "pass")
    return "Malformed required-suite declaration; rerun verification.";
  const contract = parsed.data;
  if (contract.requirements.length === 0) return;
  if (!head || !reported || reported.suiteRequirementsHash !== requirementsHash(contract))
    return "Required suites have no matching integration contract at the current SHA.";
  let measuredSha = head;
  if (reported.carriedForward === true) {
    if (typeof reported.carriedFrom !== "string" || reported.carriedFrom === head)
      return "Required suites have invalid documentation carry provenance.";
    const source = signals
      .filter(
        (s) =>
          s.signal_type === "integration" &&
          s.work_unit_id === null &&
          s.branch_head_sha === reported.carriedFrom,
      )
      .at(-1);
    const sourceDetail = detail(source);
    if (
      !source ||
      !integration ||
      source.id >= integration.id ||
      !sourceDetail ||
      sourceDetail.carriedForward === true ||
      source.result !== integration.result ||
      sourceDetail.suiteRequirementsHash !== reported.suiteRequirementsHash ||
      JSON.stringify(sourceDetail.ran) !== JSON.stringify(reported.ran)
    )
      return "Required suites have no valid one-hop documentation carry provenance.";
    measuredSha = reported.carriedFrom;
  } else if (Object.hasOwn(reported, "carriedFrom"))
    return "Unmarked required-suite documentation carry.";
  if (!Array.isArray(reported.ran)) return "Required suites have no execution receipts.";
  const jobs = reported.ran;
  const labels = jobs.map((j) => j?.label);
  if (labels.some((label) => typeof label !== "string") || new Set(labels).size !== labels.length)
    return "Integration contains missing or duplicate job identities.";
  for (const requirement of contract.requirements) {
    const job = jobs.find((j) => j.label === requirement.label);
    const observed = SuiteObservationSchema.safeParse(job?.observation);
    if (!observed.success || !job || job.kind !== "test")
      return `Required suite ${requirement.label} has no valid execution receipt.`;
    const o = observed.data;
    if (
      o.sha !== measuredSha ||
      o.command !== requirement.command ||
      o.cwd !== requirement.cwd ||
      job.exitCode !== o.exitCode ||
      job.timedOut !== o.timedOut ||
      receiptVerdict(o.suite, requirement.command, requirement.cwd, o, requirement.binding) !==
        "pass"
    )
      return `Required suite ${requirement.label} has no complete passing evidence matching its declared contract and SHA.`;
  }
}
