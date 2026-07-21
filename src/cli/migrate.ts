import { defineCommand } from "citty";
import { defaultDbPath } from "../config/paths.ts";
import { migrate } from "../db/migrate.ts";
import { guard } from "./output.ts";

export interface MigrateArgs {
  db?: string;
}

export async function migrateImpl({ args }: { args: MigrateArgs }): Promise<void> {
  const path = args.db && args.db.length > 0 ? args.db : defaultDbPath();
  const result = migrate(path);
  const verb = result.created ? "bootstrapped" : "already current";
  process.stderr.write(`${verb}: ${path} (schema v${result.version})\n`);
}

export const migrateCommand = defineCommand({
  meta: { name: "migrate", description: "Create or upgrade the SQLite database (idempotent)." },
  args: {
    db: { type: "string", description: "Path to the SQLite database file." },
  },
  run: (ctx) => guard("migrate", () => migrateImpl({ args: ctx.args as unknown as MigrateArgs })),
});
