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
}

/** The provider-neutral agent boundary. The core depends only on this; a provider
 *  (Claude, etc.) is a config-selected adapter implementing it. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
