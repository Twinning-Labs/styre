import { expect, test } from "bun:test";
import { VERSION } from "../src/version.ts";

test("`styre --version` prints the package version", async () => {
  const proc = Bun.spawn(["bun", "run", "src/index.ts", "--version"], {
    // Bun.spawn's default environment is the one Bun started with, which lacks the preload's test
    // state folder: pass this process's, so no launch record reaches the operator's real one (R29).
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain(VERSION);
});
