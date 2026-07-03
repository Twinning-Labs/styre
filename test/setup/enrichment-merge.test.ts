import { expect, test } from "bun:test";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { EnrichmentSchema } from "../../src/setup/enrichment-schema.ts";
import { mergeScanAndEnrichment } from "../../src/setup/merge.ts";

const scan = (o: unknown) => RuntimeContextSchema.parse(o);
const enr = (o: unknown) => EnrichmentSchema.parse(o);

const fullEnrichment = {
  topology: { detail: "" },
  data: { detail: "" },
  caching: { detail: "" },
  observability: { detail: "" },
  configSecrets: { detail: "" },
  documentation: { detail: "" },
  releasePackaging: { detail: "" },
};

test("agent detail wins over terse scan detail", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    enr({ ...fullEnrichment, caching: { detail: "Redis session cache, 15m TTL" } }),
  );
  expect(m.caching.detail).toBe("Redis session cache, 15m TTL");
  expect(m.caching.presence).toBe("present"); // scan flag unchanged
});

test("empty agent detail keeps the scan's terse detail", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    enr({ ...fullEnrichment, caching: { detail: "   " } }),
  );
  expect(m.caching.detail).toBe("ioredis");
});

test("agent presence is honored only where scan is unknown", () => {
  const m = mergeScanAndEnrichment(
    scan({ data: { presence: "unknown" } }),
    enr({ ...fullEnrichment, data: { presence: "present", detail: "found sqlite" } }),
  );
  expect(m.data.presence).toBe("present");
  expect(m.data.detail).toBe("found sqlite");
});

test("agent CANNOT override a confident scan flag", () => {
  const m = mergeScanAndEnrichment(
    scan({ data: { presence: "absent" } }),
    enr({ ...fullEnrichment, data: { presence: "present", detail: "x" } }),
  );
  expect(m.data.presence).toBe("absent"); // scan wins
});

test("a section left unknown by both stays unknown", () => {
  const m = mergeScanAndEnrichment(
    scan({ caching: { presence: "unknown" } }),
    enr({ ...fullEnrichment, caching: { detail: "could not tell" } }),
  );
  expect(m.caching.presence).toBe("unknown");
});

test("topology.type and releasePackaging.mechanism follow the same rule", () => {
  const m = mergeScanAndEnrichment(
    scan({ topology: { type: "unknown" }, releasePackaging: { mechanism: "semantic-release" } }),
    enr({
      ...fullEnrichment,
      topology: { type: "cli", detail: "bin entry" },
      releasePackaging: { mechanism: "installer", detail: "x" },
    }),
  );
  expect(m.topology.type).toBe("cli"); // scan unknown → agent proposal
  expect(m.releasePackaging.mechanism).toBe("semantic-release"); // scan confident → agent ignored
});

test("migrationTool: scan wins, agent fills only when scan absent", () => {
  const a = mergeScanAndEnrichment(
    scan({ data: { presence: "present", migrationTool: "prisma" } }),
    enr({ ...fullEnrichment, data: { migrationTool: "drizzle", detail: "" } }),
  );
  expect(a.data.migrationTool).toBe("prisma");
  const b = mergeScanAndEnrichment(
    scan({ data: { presence: "present" } }),
    enr({ ...fullEnrichment, data: { migrationTool: "alembic", detail: "" } }),
  );
  expect(b.data.migrationTool).toBe("alembic");
});

test("agent's pypi proposal fills an unknown release scan section (new vocabulary)", () => {
  const m = mergeScanAndEnrichment(
    scan({ releasePackaging: { mechanism: "unknown" } }),
    enr({
      ...fullEnrichment,
      releasePackaging: { mechanism: "pypi", detail: "PyPI via pyproject.toml" },
    }),
  );
  expect(m.releasePackaging.mechanism).toBe("pypi");
  expect(m.releasePackaging.detail).toBe("PyPI via pyproject.toml");
});

test("agent's browser-extension proposal fills an unknown topology scan section (new vocabulary)", () => {
  const m = mergeScanAndEnrichment(
    scan({ topology: { type: "unknown" } }),
    enr({
      ...fullEnrichment,
      topology: { type: "browser-extension", detail: "Chrome/Firefox extension" },
    }),
  );
  expect(m.topology.type).toBe("browser-extension");
});
