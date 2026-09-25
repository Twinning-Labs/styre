import { toolNamesFor } from "./capabilities.ts";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./runner.ts";

/** Test double for AgentRunner: scripts agent behavior (the handler may write files into
 *  `cwd` to simulate the agent editing the worktree) and returns a scripted result. Unless the
 *  script sets `capabilities`, it reports exactly the step's own tool set — a correctly confining
 *  provider — so tests exercise the ENG-476 check rather than bypass it. */
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
    const result = await this.handler(input);
    return result.capabilities !== undefined
      ? result
      : { ...result, capabilities: { tools: toolNamesFor(input.allowedTools), error: null } };
  }
}
