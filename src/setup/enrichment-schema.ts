import { z } from "zod";
import { PresenceEnum, ReleaseMechanismEnum, TopologyTypeEnum } from "../dispatch/profile.ts";

// Section objects are required (the prompt asks for all 7); `detail` defaults to "" so an
// agent that emits a section but omits its detail still parses. An omitted whole section makes
// the parse fail → extractSidecar reports "malformed" → enrichRuntimeContext retries. The
// optional presence/type/mechanism are PROPOSALS, honored by the merge only where scan==unknown.
// FAIL-SOFT (uniform across ALL enum-valued proposal fields — presence, type, mechanism):
// `.catch(undefined)` coerces an out-of-enum agent value to `undefined` (→ the merge's
// `?? "unknown"`), so a wild proposal degrades gracefully to `unknown` instead of failing the
// whole-section parse and crashing setup after 3 retries. This never admits the raw string into
// the profile (the vocab stays controlled), and it is scoped to the enum VALUE only — a
// wrong-typed `detail` or a whole missing section is structural corruption and STILL fails→retry.
const triSection = z.object({
  presence: PresenceEnum.optional().catch(undefined),
  detail: z.string().default(""),
});
const dataSection = z.object({
  presence: PresenceEnum.optional().catch(undefined),
  migrationTool: z.string().optional(),
  detail: z.string().default(""),
});
const topologySection = z.object({
  type: TopologyTypeEnum.optional().catch(undefined),
  detail: z.string().default(""),
});
const releaseSection = z.object({
  mechanism: ReleaseMechanismEnum.optional().catch(undefined),
  detail: z.string().default(""),
});

export const EnrichmentSchema = z.object({
  topology: topologySection,
  data: dataSection,
  caching: triSection,
  observability: triSection,
  configSecrets: triSection,
  documentation: triSection,
  releasePackaging: releaseSection,
});

export type Enrichment = z.infer<typeof EnrichmentSchema>;
