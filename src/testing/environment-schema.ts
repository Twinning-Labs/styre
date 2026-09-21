import { z } from "zod";

/** Portable intent only. Host observations never authorize another host's execution. */
const common = {
  version: z.literal(1),
  policy: z.enum(["managed", "existing"]),
  suiteCommand: z.string().min(1),
  workspaceDir: z
    .string()
    .refine(
      (s) =>
        s === "." ||
        (!s.startsWith("/") &&
          !s.includes("\\") &&
          s.split("/").every((p) => p !== ".." && p !== "." && p !== "")),
      "Unsafe workspace directory",
    )
    .default("."),
};
export const TestEnvironmentPlanSchema = z.discriminatedUnion("adapter", [
  z
    .object({
      ...common,
      adapter: z.literal("python"),
      framework: z.enum(["pytest", "django-runtests"]),
      checkLauncher: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...common,
      adapter: z.literal("node"),
      framework: z.enum(["jest", "vitest", "mocha"]),
      checkLauncher: z.string().min(1),
      manager: z.enum(["npm", "pnpm", "yarn", "bun"]),
      managerVersion: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      adapter: z.literal("karma"),
      manager: z.literal("npm"),
      managerVersion: z.string().optional(),
      configFile: z.literal("karma.conf.js"),
      browsers: z.array(z.enum(["Firefox", "FirefoxHeadless", "Chrome", "ChromeHeadless"])).min(1),
    })
    .strict(),
  z.object({ ...common, adapter: z.literal("unsupported"), reason: z.string().min(1) }).strict(),
]);
export type TestEnvironmentPlan = z.infer<typeof TestEnvironmentPlanSchema>;

export interface EnvironmentObservation {
  version: 1;
  component: string;
  phase: "inventory" | "qualification";
  status: "ready" | "empty" | "requires-preparation" | "unsupported" | "error";
  reason?: string;
  cwd: string;
  sourceSha: string | null;
  fingerprint: string;
  runtime: Record<string, unknown>;
  probes?: Array<{
    purpose: string;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }>;
  collection?: { count: number | null; exitCode: number | null; timedOut: boolean };
}

export { testCapabilities } from "./capabilities.ts";
