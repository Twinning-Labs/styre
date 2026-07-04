import { z } from "zod";
import type { Profile } from "./profile.ts";

/** One work-unit as proposed by design:extract (control-loop §3a). The daemon assigns nothing
 *  the agent can fake: completeness is checked deterministically by validateExtraction. */
export const ExtractedWorkUnitSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.string().min(1),
  title: z.string(),
  description: z.string(),
  behavioral: z.boolean(),
  test_plan: z.string().nullable(),
  files_to_touch: z.array(z.string()),
  verify_check_types: z.array(z.string()),
  depends_on: z.array(z.number().int().positive()),
});

export type ExtractedWorkUnit = z.infer<typeof ExtractedWorkUnitSchema>;

const _ImpactBase = z.object({
  applies: z.boolean().default(false),
  analysis: z.string().default(""),
});
const ImpactSchema = _ImpactBase.default(_ImpactBase.parse({}));

const _DataImpactBase = z.object({
  applies: z.boolean().default(false),
  analysis: z.string().default(""),
  schemaChange: z.boolean().default(false),
});
const DataImpactSchema = _DataImpactBase.default(_DataImpactBase.parse({}));

const _CdotImpactBase = z.object({
  data: DataImpactSchema,
  caching: ImpactSchema,
  observability: ImpactSchema,
  configSecrets: ImpactSchema,
  documentation: ImpactSchema,
});
export const CdotImpactSchema = _CdotImpactBase.default(_CdotImpactBase.parse({}));

export const ExtractOutputSchema = z.object({
  units: z.array(ExtractedWorkUnitSchema),
  cdotImpact: CdotImpactSchema,
});

export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

const MIGRATION_KINDS = new Set(["migration", "data", "db", "schema"]);

/** A work unit whose kind denotes a schema/data migration. Kind is open text (DS-5); this is a
 *  recognizer, not an enum. */
export function isMigrationKind(kind: string): boolean {
  return MIGRATION_KINDS.has(kind.trim().toLowerCase());
}

/** Profile-consistency gate (S1b postcondition, sibling to validateExtraction). Enforces only
 *  state-computable facts: flagged-section coverage + migration-unit ordering. Never grades
 *  analysis quality. Returns human-readable errors; empty array = pass. Never throws. */
export function validateCdotImpact(output: ExtractOutput, profile: Profile): string[] {
  const errors: string[] = [];
  const rc = profile.runtimeContext;
  const ci = output.cdotImpact;

  // Coverage: present|unknown ⇒ must be addressed (non-empty analysis). absent ⇒ not forced.
  const sections: Array<[string, "present" | "absent" | "unknown", { analysis: string }]> = [
    ["data", rc.data.presence, ci.data],
    ["caching", rc.caching.presence, ci.caching],
    ["observability", rc.observability.presence, ci.observability],
    ["configSecrets", rc.configSecrets.presence, ci.configSecrets],
    ["documentation", rc.documentation.presence, ci.documentation],
  ];
  for (const [name, presence, impact] of sections) {
    if ((presence === "present" || presence === "unknown") && impact.analysis.trim() === "") {
      errors.push(
        `cdotImpact.${name} must be addressed (profile flags it '${presence}') but analysis is empty`,
      );
    }
  }

  // Migration ordering: schemaChange ⇒ a migration unit exists and precedes all domain units.
  if (ci.data.schemaChange) {
    const migrationSeqs = output.units.filter((u) => isMigrationKind(u.kind)).map((u) => u.seq);
    if (migrationSeqs.length === 0) {
      errors.push(
        "cdotImpact.data.schemaChange is true but no migration work unit (kind: migration/data/db/schema) exists",
      );
    } else {
      const domainSeqs = output.units.filter((u) => !isMigrationKind(u.kind)).map((u) => u.seq);
      if (domainSeqs.length > 0 && Math.min(...migrationSeqs) > Math.min(...domainSeqs)) {
        errors.push("migration work unit must be ordered before domain-logic units (lower seq)");
      }
    }
  }
  return errors;
}

/** Deterministic completeness gate (S1b postcondition). Returns human-readable errors;
 *  an empty array means the extraction is well-formed. Never throws. */
export function validateExtraction(units: ExtractedWorkUnit[]): string[] {
  const errors: string[] = [];
  if (units.length === 0) {
    errors.push("extraction has no work units");
    return errors;
  }

  const seqs = units.map((u) => u.seq);
  const seqSet = new Set(seqs);
  const expected = new Set(Array.from({ length: units.length }, (_, i) => i + 1));
  const contiguous = seqSet.size === seqs.length && [...expected].every((s) => seqSet.has(s));
  if (!contiguous) {
    errors.push(
      `seqs must be the unique contiguous set 1..${units.length}, got [${seqs.join(", ")}]`,
    );
  }

  for (const u of units) {
    if (u.files_to_touch.length === 0) {
      errors.push(
        `unit seq ${u.seq} declares no files_to_touch (every planned unit must name ≥1 file)`,
      );
    }
    if (u.behavioral) {
      if (u.test_plan === null || u.test_plan.trim() === "") {
        errors.push(`unit seq ${u.seq} is behavioral but has no test_plan`);
      }
      if (!u.verify_check_types.includes("test")) {
        errors.push(`unit seq ${u.seq} is behavioral but verify_check_types lacks "test"`);
      }
    }
    for (const dep of u.depends_on) {
      if (dep >= u.seq) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which is not a strictly-earlier unit`);
      } else if (!seqSet.has(dep)) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which does not exist`);
      }
    }
  }
  return errors;
}
