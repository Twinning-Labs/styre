import { z } from "zod";
import { PresenceEnum, ReleaseMechanismEnum, TopologyTypeEnum } from "../dispatch/profile.ts";

// Section objects are required (the prompt asks for all 7); `detail` defaults to "" so an
// agent that emits a section but omits its detail still parses. An omitted whole section makes
// the parse fail → extractSidecar reports "malformed" → enrichRuntimeContext retries. The
// optional presence/type/mechanism are PROPOSALS, honored by the merge only where scan==unknown.
const triSection = z.object({ presence: PresenceEnum.optional(), detail: z.string().default("") });
const dataSection = z.object({
  presence: PresenceEnum.optional(),
  migrationTool: z.string().optional(),
  detail: z.string().default(""),
});
const topologySection = z.object({
  type: TopologyTypeEnum.optional(),
  detail: z.string().default(""),
});
const releaseSection = z.object({
  mechanism: ReleaseMechanismEnum.optional(),
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
