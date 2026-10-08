// test/lifecycle/fixtures/pty-shell.ts: the terminal's shell, for test/lifecycle/pty.ts. It is the
// first process in the pseudo terminal (its session leader, where a login shell would be) and runs
// one command there, so the command is in the terminal's foreground group and gets its keystrokes.
//
// It does what a shell does around its job, and no more:
//   - a keystroke's signal (Ctrl-C, Ctrl-\) and a SIGTERM leave it running: it waits for its job;
//   - when the terminal closes, the kernel sends SIGHUP to the session leader only (checked on macOS
//     and Linux): like an interactive shell, it sends SIGHUP on to its job;
//   - when the job ends it writes how, `{"code":…,"signal":…}`, to $PTY_STATUS (through a temporary
//     file, so a reader never sees half of it), and exits.
// It writes the job's pid to $PTY_STATUS.pid as soon as the job starts. It never writes to the
// terminal, so a closed terminal cannot end it early.
import { renameSync, writeFileSync } from "node:fs";

const status = process.env.PTY_STATUS;
if (!status) throw new Error("pty-shell: PTY_STATUS is not set");

let job: Bun.Subprocess | null = null;
for (const s of ["SIGINT", "SIGQUIT", "SIGTERM"] as const) process.on(s, () => {});
process.on("SIGHUP", () => {
  job?.kill("SIGHUP");
});

job = Bun.spawn(process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
writeFileSync(`${status}.pid`, `${job.pid}\n`);
await job.exited;
writeFileSync(`${status}.tmp`, JSON.stringify({ code: job.exitCode, signal: job.signalCode }));
renameSync(`${status}.tmp`, status);
process.exit(0);
