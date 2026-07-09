import { expect, test } from "bun:test";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";

test("ensurePr creates, then updates the body only when it differs", async () => {
  const f = fakeForge();
  const a = await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-A" });
  expect(a.ref).not.toBeNull();
  // same body → no update recorded
  await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-A" });
  expect(f.calls.filter((c) => c.method === "updatePrBody")).toHaveLength(0);
  // changed body → one update recorded, same ref returned
  const c = await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-B" });
  expect(c.ref).toBe(a.ref);
  const updates = f.calls.filter((c) => c.method === "updatePrBody");
  expect(updates).toHaveLength(1);
  expect((updates[0].args[0] as { body: string }).body).toBe("BODY-B");
});

test("a new branch creates a fresh PR (no update)", async () => {
  const f = fakeForge();
  await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "X" });
  await f.ensurePr({ branch: "b2", base: "main", title: "t", body: "Y" });
  expect(f.calls.filter((c) => c.method === "updatePrBody")).toHaveLength(0);
  expect(f.calls.filter((c) => c.method === "ensurePr")).toHaveLength(2);
});
