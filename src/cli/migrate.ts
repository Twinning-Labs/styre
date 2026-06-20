import { defineCommand } from "citty";
import { defaultDbPath } from "../config/paths.ts";
import { migrate } from "../db/migrate.ts";

export const migrateCommand = defineCommand({
  meta: { name: "migrate", description: "Create or upgrade the SQLite database (idempotent)." },
  args: {
    db: { type: "string", description: "Path to the SQLite database file." },
  },
  run({ args }) {
    const path = args.db && args.db.length > 0 ? args.db : defaultDbPath();
    const result = migrate(path);
    const verb = result.created ? "bootstrapped" : "already current";
    console.log(`${verb}: ${path} (schema v${result.version})`);
  },
});
