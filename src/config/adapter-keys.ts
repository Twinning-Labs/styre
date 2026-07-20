/** The valid adapter keys, mirrored from the wiring maps (daemon/ports.ts, agent/resolve.ts).
 *  Kept here so config validation can name the valid values without importing the adapters. */
export const ISSUE_TRACKER_KEYS = ["linear", "jira"] as const;
export const FORGE_KEYS = ["github"] as const;
export const PROVIDER_KEYS = ["claude", "codex"] as const;
export const NOTIFIER_KEYS = ["none", "slack"] as const; // "none" is a sentinel, not an adapter
