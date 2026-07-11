import { githubChecks } from "../integrations/adapters/github-checks.ts";
import { githubForge } from "../integrations/adapters/github.ts";
import { linearIssueTracker } from "../integrations/adapters/linear.ts";
import { slackNotifier } from "../integrations/adapters/slack.ts";
import { type ChecksFactory, selectChecks } from "../integrations/checks.ts";
import { type ForgeFactory, selectForge } from "../integrations/forge.ts";
import { type IssueTrackerFactory, selectIssueTracker } from "../integrations/issue-tracker.ts";
import { type NotifierFactory, selectNotifier } from "../integrations/notifier.ts";
import type { ProjectorPorts } from "./projector.ts";

/** Build the outward ports from runtime config + profile, reading creds from env via the real
 *  adapters. `deps` overrides the adapter maps (tests inject fakes). The daemon entrypoint's single
 *  wiring point — mirrors selectForge/selectIssueTracker (config in, live ports out). */
export function makeProjectorPorts(
  runtimeConfig: {
    issueTracker: string;
    forge: string;
    notifier?: string;
    slack?: { channel: string };
  },
  profile: { checksSystem: string; targetRepo: string },
  deps?: {
    issueTracker?: Record<string, IssueTrackerFactory>;
    forge?: Record<string, ForgeFactory>;
    checks?: Record<string, ChecksFactory>;
    notifier?: Record<string, NotifierFactory>;
  },
): ProjectorPorts {
  const itAdapters = deps?.issueTracker ?? { linear: () => linearIssueTracker() };
  const forgeAdapters = deps?.forge ?? {
    github: () => githubForge({ repoPath: profile.targetRepo }),
  };
  const checksAdapters = deps?.checks ?? {
    github: () => githubChecks({ repoPath: profile.targetRepo }),
  };
  const notifierAdapters = deps?.notifier ?? {
    slack: () =>
      slackNotifier({
        token: process.env.SLACK_BOT_TOKEN ?? "",
        channel: runtimeConfig.slack?.channel ?? "",
      }),
  };
  return {
    issueTracker: selectIssueTracker(runtimeConfig, itAdapters),
    forge: selectForge(runtimeConfig, forgeAdapters),
    checks: selectChecks(profile.checksSystem, checksAdapters) ?? undefined,
    notifier: selectNotifier({ notifier: runtimeConfig.notifier ?? "none" }, notifierAdapters),
  };
}
