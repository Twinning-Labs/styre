import { ZodError } from "zod";
import { configError } from "../cli/errors.ts";

/** Parse `raw` with `schema`, converting a ZodError into a file-named ConfigError.
 *  Standalone (imported by both discover.ts and profile.ts) to avoid an import cycle. */
export function parseConfigOrThrow<T>(
  schema: { parse(x: unknown): T },
  raw: unknown,
  file: string,
): T {
  try {
    return schema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first ? first.path.join(".") || "(root)" : "(root)";
      const detail = err.issues
        .map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw configError({ file, field, detail, recovery: "Fix the value and re-run." });
    }
    throw err;
  }
}
