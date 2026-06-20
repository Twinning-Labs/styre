import { expect, test } from "bun:test";
import { VERSION } from "../src/version.ts";

test("`styre --version` prints the package version", async () => {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain(VERSION);
});
