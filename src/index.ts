#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { VERSION } from "./version.ts";

// citty delegates --version to consola, which suppresses output when not in a
// TTY (e.g. when spawned in tests). Write directly to stdout first so the test
// can reliably capture the version string.
if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const main = defineCommand({
  meta: {
    name: "styre",
    version: VERSION,
    description: "The open-source autonomous-SDLC execution core.",
  },
  subCommands: {},
});

runMain(main);
