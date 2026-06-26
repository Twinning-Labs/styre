import { PostHog } from "posthog-node";

/** PostHog US Cloud ingestion host. */
export const POSTHOG_HOST = "https://us.i.posthog.com";
/** Write-only project API key — safe to ship in the OSS binary. REPLACE with your project key. */
export const POSTHOG_TOKEN = "phc_REPLACE_WITH_PROJECT_KEY";

const FLUSH_TIMEOUT_MS = 2000;

export interface AnalyticsClient {
  capture(distinctId: string, event: string, properties: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

/** A fail-silent posthog-node wrapper tuned for a short-lived CLI. Errors never surface; only
 *  shutdown() is awaited, bounded so a slow network can never hang the process. */
export function createPosthogClient(): AnalyticsClient {
  const ph = new PostHog(POSTHOG_TOKEN, {
    host: POSTHOG_HOST,
    flushAt: 1, // short-lived process: send promptly
    flushInterval: 0, // no background timer
  });
  return {
    capture(distinctId, event, properties) {
      try {
        ph.capture({ distinctId, event, properties });
      } catch {
        // never let telemetry throw into the CLI
      }
    },
    async shutdown() {
      await Promise.race([
        ph.shutdown().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    },
  };
}
