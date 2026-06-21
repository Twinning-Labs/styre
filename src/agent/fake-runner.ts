import type { AgentRunInput, AgentRunResult, AgentRunner } from "./runner.ts";

/** Test double for AgentRunner: scripts agent behavior (the handler may write files into
 *  `cwd` to simulate the agent editing the worktree) and returns a scripted result. */
export class FakeAgentRunner implements AgentRunner {
  readonly inputs: AgentRunInput[] = [];
  constructor(
    private readonly handler: (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.inputs.push(input);
    if (input.onSpawn) {
      input.onSpawn(424242);
    }
    return this.handler(input);
  }
}
