/** Process-group control for agent CLIs (ENG-476). An agent is spawned as the leader of its own
 *  process group (`detached: true`), so a kill reaches everything it started — a wrapper script
 *  or version-manager shim and the real CLI beneath it — not just the direct child. */

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** SIGKILL the whole process group led by `pid`. Falls back to the single pid when no such group
 *  exists (a process that is not a group leader). Never throws: a group already gone is done. */
export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // no such group — fall through to the single process
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** While an agent runs in its own process group, a Ctrl-C (or SIGTERM/SIGHUP) sent to the runner
 *  no longer reaches it through the terminal. This forwards those signals: it kills the agent's
 *  group, removes its own handlers and re-raises the signal so the runner terminates exactly as it
 *  would have without the handler. Returns a disposer that removes the handlers. */
export function forwardTerminationSignals(pid: number): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => {
      killProcessGroup(pid);
      dispose();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return dispose;
}
