/** Process-group control for agent CLIs (ENG-476). An agent is spawned as the leader of its own
 *  process group (`detached: true`), so a kill reaches everything it started in that group — a
 *  wrapper script or version-manager shim and the real CLI beneath it — not just the direct child.
 *
 *  Claude Code runs each Bash tool command in a SEPARATE process group and reaps those groups when
 *  it is asked to stop. So stopping a running agent is graceful first (the signal, a bounded wait),
 *  and only then SIGKILL; a bare SIGKILL is reserved for the startup gate, where no tool has run. */

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/** How long a forwarded signal gives the agent to stop (and reap its tools) before SIGKILL. */
export const FORWARD_GRACE_MS = 2_000;

/** SIGKILL a process group. A NEGATIVE pid is the journal's convention for "the group led by
 *  -pid" (verify suites, review probes) and is killed as that group. A positive pid is treated as
 *  a group leader; when no such group exists it falls back to the single process. Never throws. */
export function killProcessGroup(pid: number): void {
  if (pid < 0) {
    signalQuietly(pid, "SIGKILL");
    return;
  }
  if (!signalQuietly(-pid, "SIGKILL")) signalQuietly(pid, "SIGKILL");
}

/** Ask the group led by `pid` to stop with `signal`, wait up to `graceMs` for it to empty, then
 *  SIGKILL whatever remains. Resolves once the group is gone or has been killed. */
export async function terminateProcessGroup(
  pid: number,
  signal: NodeJS.Signals,
  graceMs: number,
): Promise<void> {
  if (!signalQuietly(-pid, signal)) signalQuietly(pid, signal);
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
  if (groupAlive(pid)) killProcessGroup(pid);
}

/** The synchronous twin of `terminateProcessGroup`, for use inside a signal handler that must
 *  finish before re-raising the signal. */
export function terminateProcessGroupSync(
  pid: number,
  signal: NodeJS.Signals,
  graceMs: number,
): void {
  if (!signalQuietly(-pid, signal)) signalQuietly(pid, signal);
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) Bun.sleepSync(25);
  if (groupAlive(pid)) killProcessGroup(pid);
}

/** While an agent runs in its own process group (and session), a Ctrl-C, Ctrl-\, SIGTERM or
 *  SIGHUP sent to the runner no longer reaches it through the terminal. This forwards those
 *  signals: it stops the agent's group gracefully (so the agent can reap its tools), removes its
 *  own handlers and re-raises the signal so the runner terminates exactly as it would have without
 *  them. Returns a disposer that removes the handlers. */
export function forwardTerminationSignals(pid: number): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const dispose = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };
  for (const signal of TERMINATION_SIGNALS) {
    const handler = () => {
      terminateProcessGroupSync(pid, signal, FORWARD_GRACE_MS);
      dispose();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return dispose;
}

/** True while any process remains in the group led by `pid` (or, with no such group, while the
 *  process itself is alive). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/** Send `signal` to `target` (a pid, or a negative group id); false when there was no target. */
function signalQuietly(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}
