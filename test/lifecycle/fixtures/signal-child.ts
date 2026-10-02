// test/lifecycle/fixtures/signal-child.ts: a process with the real stop handlers installed (real
// stderr, re-raise and exit), for the signals tests. `stubborn` also launches an agent that ignores
// SIGTERM, so only a forced stop ends it; `slow` gives the handler an analytics shutdown that takes
// 300 ms, as a real one can (a write's failure after hangup then has time to surface). It says
// "ready" on stderr once the handlers are in place.
import { join } from "node:path";
import { launch } from "../../../src/util/process/door.ts";
import { installStopHandlers } from "../../../src/util/process/signals.ts";

installStopHandlers({
  command: "run",
  run: null,
  ...(process.argv[2] === "slow"
    ? { shutdownAnalytics: (ms: number) => Bun.sleep(Math.min(ms, 300)) }
    : {}),
});
if (process.argv[2] === "stubborn") {
  launch({
    argv: ["bash", join(import.meta.dir, "stubborn-cli.sh")],
    cwd: process.cwd(),
    env: process.env,
    kind: "agent",
    context: { ident: "ENG-1", stepId: null, worktree: null },
  });
}
process.stderr.write("ready\n");
setInterval(() => {}, 1_000);
