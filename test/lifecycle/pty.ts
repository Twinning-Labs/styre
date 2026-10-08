// test/lifecycle/pty.ts: runs a command under a real pseudo terminal, so a test can press Ctrl-C or
// Ctrl-\ the way a person does, and close the terminal for real (ENG-485 Task 15).
//
// The terminal comes from `script`: `script -q /dev/null <cmd>` on macOS, `script -qfc "<cmd>"
// /dev/null` on Linux. Keystrokes are written to script's standard input, which script passes to the
// terminal: the terminal turns `\x03` into SIGINT and `\x1c` into SIGQUIT for its foreground group.
// script's standard input must be a real pipe: macOS script refuses a socket (`tcgetattr/ioctl:
// Operation not supported on socket`), and both Bun's "pipe" and a FIFO are sockets on macOS, so
// the pipe comes from pipe(2) through bun:ffi.
//
// Inside the terminal, fixtures/pty-shell.ts plays the shell: it runs the command as its job,
// reports the job's pid and how the job ended (a signal, or an exit code), and passes SIGHUP on
// when the terminal closes, as a shell does. `close()` closes the terminal for real: it kills
// script, which holds the terminal's other side.
//
// Every process here is the test's own: script is claimed the moment it starts, the shell and the
// command by descent as soon as their pids are known (test/helpers/own-processes.ts). Nothing is
// found by its command text.
import { FFIType, dlopen, ptr } from "bun:ffi";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcInfo, nowToken, probe } from "../../src/util/process/proc-table.ts";
import { own, ownPrinted, signalOwned, until } from "../helpers/own-processes.ts";

const SHELL = join(import.meta.dir, "fixtures", "pty-shell.ts");

/** Ctrl-C and Ctrl-\ as a terminal receives them. */
export const CTRL_C = "\x03";
export const CTRL_BACKSLASH = "\x1c";

/** How the command ended, as its shell saw it. */
export interface Ended {
  code: number | null;
  signal: string | null;
}

export interface Pty {
  /** script itself: the test's own child, claimed at once. */
  script: ProcInfo;
  /** Everything the terminal has shown so far, its `\r\n` line ends turned into `\n`. */
  output(): string;
  /** Wait (bounded) until the output contains `text` or matches it. */
  waitFor(text: string | RegExp, ms?: number): Promise<boolean>;
  /** Type into the terminal (a keystroke, or an answer and its Enter). */
  type(text: string): void;
  /** The command's own process, claimed by descent: its shell reports its pid as it starts it. */
  command(ms?: number): Promise<ProcInfo>;
  /** Close the terminal for real: script, which holds its other side, is killed. The session's
   *  leader (the shell) gets SIGHUP from the kernel and passes it on to the command. */
  close(): Promise<void>;
  /** How the command ended, once its shell has said so; null if that takes longer than `ms`. */
  ended(ms?: number): Promise<Ended | null>;
  /** Close the keyboard side and remove the status folder. The processes are the caller's to clean
   *  up, through `killOwned`. */
  dispose(): void;
}

let libc: { pipe: (fds: Int32Array) => number } | null = null;
/** A real pipe(2): `[read end, write end]`. */
function realPipe(): [number, number] {
  if (libc === null) {
    const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    libc = { pipe: (fds) => lib.symbols.pipe(ptr(fds)) as number };
  }
  const fds = new Int32Array(2);
  if (libc.pipe(fds) !== 0) throw new Error("pty: pipe(2) failed");
  return [fds[0] as number, fds[1] as number];
}

/** One word for `sh -c`, quoted so the shell takes it as it is. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The `script` command line that runs `argv` in a new terminal. */
export function scriptArgv(argv: string[], platform: NodeJS.Platform = process.platform): string[] {
  return platform === "linux"
    ? // `exec`: the shell fixture itself leads the session, so it is the one the kernel tells.
      ["script", "-qfc", `exec ${argv.map(quote).join(" ")}`, "/dev/null"]
    : ["script", "-q", "/dev/null", ...argv];
}

/**
 * Start `argv` in a new pseudo terminal, under the shell fixture. `env` is the whole environment
 * (pass `{ ...process.env, … }`: a child must inherit the test's state folder, R29).
 */
export function underPty(
  argv: string[],
  opts: { env: Record<string, string | undefined>; cwd?: string },
): Pty {
  const dir = mkdtempSync(join(tmpdir(), "styre-pty-"));
  const status = join(dir, "status");
  const since = nowToken();
  const [readEnd, writeEnd] = realPipe();
  let keyboard: number | null = writeEnd;
  let proc: Bun.Subprocess<number, "pipe", "pipe">;
  try {
    proc = Bun.spawn(scriptArgv([process.execPath, SHELL, ...argv]), {
      cwd: opts.cwd,
      env: { ...opts.env, PTY_STATUS: status, SHELL: "/bin/sh" },
      stdin: readEnd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    closeSync(readEnd);
  }
  const me = probe(proc.pid);
  const claimed = me.kind === "alive" ? own(me.info)[0] : undefined;
  if (claimed === undefined) {
    proc.kill("SIGKILL");
    closeSync(writeEnd);
    throw new Error(`pty: script (pid ${proc.pid}) could not be claimed`);
  }

  let text = "";
  const dec = new TextDecoder();
  // Read all the time: a full pipe would stop script, and then the command's own writes.
  for (const stream of [proc.stdout, proc.stderr]) {
    void (async () => {
      const reader = stream.getReader();
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        text += dec.decode(r.value, { stream: true });
      }
    })();
  }
  const output = (): string => text.replace(/\r\n/g, "\n");

  return {
    script: claimed,
    output,
    async waitFor(want, ms = 10_000) {
      return until(
        () => (typeof want === "string" ? output().includes(want) : want.test(output())),
        ms,
      );
    },
    type(keys) {
      if (keyboard === null) throw new Error("pty: the keyboard side is closed");
      writeSync(keyboard, keys);
    },
    async command(ms = 10_000) {
      let pid = Number.NaN;
      await until(() => {
        if (!existsSync(`${status}.pid`)) return false;
        pid = Number(readFileSync(`${status}.pid`, "utf8").trim());
        return Number.isInteger(pid);
      }, ms);
      const p = Number.isInteger(pid) ? ownPrinted(pid, since) : null;
      if (p === null) throw new Error(`pty: the command (pid ${pid}) could not be claimed`);
      return p;
    },
    async close() {
      if (!signalOwned(claimed, "SIGKILL")) throw new Error("pty: script could not be signalled");
      await proc.exited;
    },
    async ended(ms = 10_000) {
      const ok = await until(() => existsSync(status), ms);
      if (!ok) return null;
      return JSON.parse(readFileSync(status, "utf8")) as Ended;
    },
    dispose() {
      if (keyboard !== null) closeSync(keyboard);
      keyboard = null;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The status a shell reports for how a command ended: 128 + n for a signal. */
export function shellStatus(e: Ended): number {
  if (e.signal === null) return e.code ?? -1;
  return 128 + (constants.signals[e.signal as NodeJS.Signals] ?? 0);
}
