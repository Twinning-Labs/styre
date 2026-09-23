import { expect, test } from "bun:test";
import { EXIT, StyreError } from "../../src/cli/errors.ts";
import { resolvePrBase } from "../../src/cli/resolve-pr-base.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";

test("keeps the profile's branch when it exists on the forge", async () => {
  const forge = fakeForge({ defaultBranch: "main", branches: ["main", "develop"] });
  expect(await resolvePrBase(forge, "develop")).toEqual({ base: "develop" });
});

// The 20 Sept Sphinx run: setup read a stale origin/HEAD (`master`) left in the image, while the
// seeded repo only had `main`, so every PR request was rejected as `base invalid`.
test("falls back to the forge's default branch when the profile's branch is missing there", async () => {
  const forge = fakeForge({ defaultBranch: "main", branches: ["main"] });
  expect(await resolvePrBase(forge, "master")).toEqual({
    base: "main",
    replaced: { from: "master", to: "main" },
  });
});

test("refuses to start when the forge has no usable base branch at all", async () => {
  const forge = fakeForge({ defaultBranch: "main", branches: [] });
  const err = await resolvePrBase(forge, "master").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StyreError);
  expect((err as StyreError).code).toBe(EXIT.CONFIG);
  expect((err as StyreError).headline).toMatch(/base branch/);
});
