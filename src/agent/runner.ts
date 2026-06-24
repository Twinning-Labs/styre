/** Provider-neutral classification of a non-completing dispatch (control-loop §3a / ENG-164).
 *  Only a provider adapter sets this; the core routes on it and never matches provider strings. */
export type FailureCause = "session-limit" | "out-of-credits" | "transient";

export interface AgentRunInput {
  prompt: string;
  model: string;
  allowedTools: string[];
  cwd: string;
  timeoutMs: number;
  onSpawn?: (pid: number) => void;
}

export interface AgentRunResult {
  completed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Prompt-cache token accounting (optional: not every provider reports it). Recorded on the
   *  dispatch row for cost attribution; absent → treated as null. */
  cacheRead?: number | null;
  cacheCreate?: number | null;
  /** Set by the adapter when `completed` is false: why the dispatch did not complete.
   *  Absent → treated as "transient" (today's retry behavior). */
  cause?: FailureCause;
  /** For session-limit only: the provider's raw human reset text (display-only). */
  resetAt?: string | null;
}

/** The provider-neutral agent boundary. The core depends only on this; a provider
 *  (Claude, etc.) is a config-selected adapter implementing it. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
