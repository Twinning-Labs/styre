#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { migrateCommand } from "./cli/migrate.ts";
import { runCommand } from "./cli/run.ts";
import { VERSION } from "./version.ts";

// citty delegates --version to consola, which suppresses output when not in a
// TTY (e.g. when spawned in tests). Write directly to stdout first so the test
// can reliably capture the version string. We check only the first user-facing
// argument (process.argv[2]) so that `styre migrate --version` is NOT
// intercepted here — subcommands get their own flag handling from citty.
if (process.argv.slice(2)[0] === "--version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const main = defineCommand({
  meta: {
    name: "styre",
    version: VERSION,
    description: "The open-source autonomous-SDLC execution core.",
  },
  subCommands: {
    migrate: migrateCommand,
    run: runCommand,
  },
});

runMain(main);
