import { expect, test } from "bun:test";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { mergeRuntimeContext } from "../../src/setup/merge.ts";

const rc = (o: unknown) => RuntimeContextSchema.parse(o);

test("operator-resolved value survives an unknown re-probe", () => {
  const existing = rc({ caching: { presence: "present", detail: "redis (operator)" } });
  const probed = rc({ caching: { presence: "unknown", detail: "" } });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.caching.presence).toBe("present");
  expect(merged.caching.detail).toBe("redis (operator)");
});

test("a confident probe overwrites a stale existing value", () => {
  const existing = rc({ data: { presence: "absent" } });
  const probed = rc({ data: { presence: "present", detail: "prisma", migrationTool: "prisma" } });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.data.presence).toBe("present");
  expect(merged.data.migrationTool).toBe("prisma");
});

test("topology/release: a non-unknown probe wins, else existing survives", () => {
  const existing = rc({
    topology: { type: "desktop" },
    releasePackaging: { mechanism: "app-store" },
  });
  const probed = rc({
    topology: { type: "unknown" },
    releasePackaging: { mechanism: "semantic-release" },
  });
  const merged = mergeRuntimeContext(existing, probed);
  expect(merged.topology.type).toBe("desktop"); // probe unknown → keep operator
  expect(merged.releasePackaging.mechanism).toBe("semantic-release"); // probe confident → win
});
