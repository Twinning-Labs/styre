import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  assistantText,
  buildClaudeArgs,
  claudeAgentRunner,
  parseClaudeJson,
  parseClaudeStream,
} from "../../../src/agent/providers/claude.ts";
import { extractSidecar } from "../../../src/dispatch/sidecar.ts";
import { nowToken } from "../../../src/util/process/proc-table.ts";

import { claimLaunchesAtStops } from "../../helpers/claim-launches.ts";
import { installVirtualGrace, resetDoorAfterEach } from "../../helpers/graceful-stop.ts";
import { killOwned, ownPrinted, until } from "../../helpers/own-processes.ts";
import { makeTempDir } from "../../helpers/temp.ts";

resetDoorAfterEach();
// Every stop a test causes claims what the launch is running first (test/helpers/claim-launches.ts),
// so a stop that fails to end a fake CLI's child still leaves it to afterEach's cleanup.
beforeEach(() => claimLaunchesAtStops());
// The processes a fake CLI leaves behind on purpose, known by the pid it wrote: killed by that
// identity after each test, never by searching for their command.
afterEach(() => killOwned());

const cwd = realpathSync(makeTempDir("styre-claude-"));

/** Write an executable stand-in for the `claude` CLI that ignores its argv and runs `body`. */
function fakeCli(name: string, body: string): string {
  const path = join(cwd, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const runInput = { prompt: "hi", model: "m", allowedTools: ["Read"], cwd, timeoutMs: 5000 };

/** One `stream-json` line, as `claude -p --output-format stream-json --verbose` prints it. */
const line = (o: unknown): string => JSON.stringify(o);
const initLine = (tools: string[], permissionMode = "dontAsk"): string =>
  line({ type: "system", subtype: "init", tools, permissionMode, mcp_servers: [] });
const resultLine = (o: Record<string, unknown>): string =>
  line({ type: "result", subtype: "success", ...o });
/** A fake CLI body that prints the given stream lines verbatim. */
const printLines = (lines: string[]): string => `cat <<'EOF'\n${lines.join("\n")}\nEOF`;

test("buildClaudeArgs pins the exact tool set, a non-prompting mode, and no outside settings or servers (ENG-476)", () => {
  const args = buildClaudeArgs({
    model: "claude-opus-4-8",
    allowedTools: ["Read", "Write", "Bash(npm test:*)"],
  });
  expect(args).toEqual([
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-opus-4-8",
    "--restricted",
    "--tools",
    "Bash,Read,Write",
    "--allowedTools",
    "Read Write Bash(npm test:*)",
    "--permission-mode",
    "dontAsk",
    "--strict-mcp-config",
  ]);
});

test("buildClaudeArgs passes an empty tool set explicitly, never omitting --tools", () => {
  const args = buildClaudeArgs({ model: "m", allowedTools: [] });
  expect(args[args.indexOf("--tools") + 1]).toBe("");
});

test("parseClaudeStream reads the init event's tools and mode and the final result envelope", () => {
  const parsed = parseClaudeStream(
    [
      initLine(["Read", "Glob"]),
      line({ type: "assistant", message: { content: [] } }),
      resultLine({ result: "done", total_cost_usd: 0.25 }),
    ].join("\n"),
  );
  expect(parsed.init).toEqual({ tools: ["Read", "Glob"], permissionMode: "dontAsk" });
  expect(parsed.result).toMatchObject({ result: "done", total_cost_usd: 0.25 });
});

test("parseClaudeStream tolerates noise lines and reports absent events as null", () => {
  expect(parseClaudeStream("not json\n\n")).toEqual({ init: null, result: null });
});

test("parseClaudeJson extracts usage incl. cache tokens, tolerating missing fields", () => {
  const good = parseClaudeJson(
    JSON.stringify({
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 2,
      },
    }),
  );
  expect(good.costUsd).toBe(0.5);
  expect(good.tokensIn).toBe(10);
  expect(good.cacheRead).toBe(7);
  expect(good.cacheCreate).toBe(2);
  // cache fields absent → null (not every response reports them)
  const noCache = parseClaudeJson(JSON.stringify({ usage: { input_tokens: 1 } }));
  expect(noCache.cacheRead).toBeNull();
  expect(noCache.cacheCreate).toBeNull();
  const bad = parseClaudeJson("not json");
  expect(bad).toEqual({
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    cacheRead: null,
    cacheCreate: null,
  });
});

test("run captures a clean exit and parses usage", async () => {
  const cli = fakeCli(
    "claude-ok",
    printLines([
      initLine(["Read"]),
      resultLine({
        result: "ok",
        total_cost_usd: 0.5,
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    ]),
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.costUsd).toBe(0.5);
  expect(r.stdout).toBe("ok");
  expect(r.capabilities).toEqual({ tools: ["Read"], error: null });
});

test("run reports an enforcement error when the CLI emits no init event (tool set unverifiable)", async () => {
  const cli = fakeCli("claude-noinit", printLines([resultLine({ result: "ok" })]));
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.capabilities?.tools).toBeNull();
  expect(r.capabilities?.error).toContain("no init event");
});

test("run reports an enforcement error when the CLI ran in a different permission mode", async () => {
  const cli = fakeCli(
    "claude-auto",
    printLines([initLine(["Read"], "auto"), resultLine({ result: "ok" })]),
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.capabilities?.tools).toEqual(["Read"]);
  expect(r.capabilities?.error).toContain("permission mode 'auto'");
});

test("run passes the pinned argv to the CLI", async () => {
  const argvFile = join(cwd, "argv.txt");
  const cli = fakeCli(
    "claude-argv",
    `printf '%s\\n' "$@" > '${argvFile}'\n${printLines([initLine(["Read"]), resultLine({ result: "ok" })])}`,
  );
  await claudeAgentRunner(cli).run({ ...runInput });
  const argv = (await Bun.file(argvFile).text()).trim().split("\n");
  expect(argv).toEqual(buildClaudeArgs({ model: "m", allowedTools: ["Read"] }));
});

// M1: the timeout is a HARD bound — a process that ignores SIGTERM must still be killed and the
// call must return promptly (not hang on `proc.exited`).
test("a timeout starts a graceful stop: the first signal sent to a hung CLI is SIGTERM, never SIGKILL (ENG-485 6.3)", async () => {
  // Only the order of the first signal is asserted, which depends on no timing: whether the CLI
  // yields to SIGTERM is not part of this test. The escalation after the grace period is tested at
  // the stop level (test/lifecycle/graceful-escalation.test.ts), where the process is known to be
  // ready. The stop's clock is virtual and signals are recorded.
  const rec = installVirtualGrace();
  const cli = fakeCli("claude-hang", "sleep 307");
  const r = await claudeAgentRunner(cli).run({ ...runInput, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.completed).toBe(false);
  // ENG-164: timeout path must classify as transient with no reset date
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
  expect(rec.sent.length).toBeGreaterThan(0);
  expect(rec.sent[0]?.sig).toBe("SIGTERM");
});

test("run classifies spawn failure as transient (non-existent command)", async () => {
  const r = await claudeAgentRunner("/nonexistent-styre-claude-cli").run({
    ...runInput,
    timeoutMs: 5000,
  });
  expect(r.completed).toBe(false);
  expect(r.timedOut).toBe(false);
  // ENG-164: spawn failure goes through the catch branch → transportFailure → cause: "transient"
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("assistantText unwraps the envelope result field, falling back to raw", () => {
  const raw = JSON.stringify({ result: "hello\nworld", usage: { input_tokens: 1 } });
  expect(assistantText(raw)).toBe("hello\nworld");
  // no result field → raw passthrough (never the string "undefined")
  const noResult = JSON.stringify({ usage: { input_tokens: 1 } });
  expect(assistantText(noResult)).toBe(noResult);
  expect(assistantText("not json")).toBe("not json");
});

test("a claude success carrying a sidecar block yields extractable stdout (regression)", async () => {
  const sidecar = `\`\`\`styre-sidecar\n${JSON.stringify({ n: 5 })}\n\`\`\``;
  // real claude carries the assistant text (incl. the fenced block) in the final result event
  const cli = fakeCli(
    "claude-sidecar",
    printLines([
      initLine(["Read"]),
      resultLine({ result: `done\n${sidecar}`, usage: { input_tokens: 1 } }),
    ]),
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  const parsed = extractSidecar(r.stdout, z.object({ n: z.number() }));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.n).toBe(5);
});

// Review finding 1: stream-json stdout carries every tool result (file contents included), so a
// failure must be classified from stderr and the final result only — never the transcript.
test("a limit marker quoted inside a tool result does not turn a server error into a pause", async () => {
  const cli = fakeCli(
    "claude-quoted-marker",
    `${printLines([
      initLine(["Read"]),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "/hit your session limit|usage limit reached/" },
          ],
        },
      }),
      resultLine({ is_error: true, result: "API Error: 500 Internal server error" }),
    ])}\nexit 1`,
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(false);
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
});

test("the reset text comes from the result event, never from transcript content", async () => {
  const cli = fakeCli(
    "claude-reset-leak",
    `${printLines([
      initLine(["Read"]),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: "git reset --hard HEAD then export DB_PASSWORD=hunter2",
            },
          ],
        },
      }),
      resultLine({
        is_error: true,
        result: "You've hit your session limit · resets 3pm (Europe/Berlin)",
      }),
    ])}\nexit 1`,
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.cause).toBe("session-limit");
  expect(r.resetAt).toBe("3pm (Europe/Berlin)");
  expect(JSON.stringify(r)).not.toContain("hunter2");
});

test("a limit message the CLI prints as plain (non-JSON) stdout is still classified", async () => {
  const cli = fakeCli(
    "claude-plain-limit",
    'echo "You\'ve hit your session limit · resets 9am"\nexit 1',
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.cause).toBe("session-limit");
  expect(r.resetAt).toBe("9am");
});

// Review finding 2: confinement is enforced at startup, before the agent can act.
test("an agent reported with an extra tool is killed at startup, before it can act", async () => {
  const marker = join(cwd, "acted-after-bad-init.txt");
  const cli = fakeCli(
    "claude-wide-init",
    `${printLines([initLine(["Read", "Bash"])])}\nsleep 5 </dev/null >/dev/null 2>&1\ntouch '${marker}'\n${printLines([resultLine({ result: "ok" })])}`,
  );
  const start = Date.now();
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(Date.now() - start).toBeLessThan(3000); // killed on the init line, not after the sleep
  expect(existsSync(marker)).toBe(false);
  expect(r.completed).toBe(false);
  expect(r.capabilities?.tools).toEqual(["Read", "Bash"]);
  expect(r.capabilities?.error).toContain("stopped at startup: unexpected tools: Bash");
});

test("an agent that acts before claude reports its tools is killed", async () => {
  const marker = join(cwd, "acted-before-init.txt");
  const cli = fakeCli(
    "claude-act-first",
    `${printLines([line({ type: "assistant", message: { content: [] } })])}\nsleep 5 </dev/null >/dev/null 2>&1\ntouch '${marker}'`,
  );
  const start = Date.now();
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(Date.now() - start).toBeLessThan(3000);
  expect(existsSync(marker)).toBe(false);
  expect(r.completed).toBe(false);
  expect(r.capabilities?.error).toContain("acted before claude reported its tools");
});

test("a run that dies before reporting its tools is an ordinary failure, not a confinement fault", async () => {
  const cli = fakeCli("claude-early-death", "echo 'API Error: overloaded' >&2\nexit 1");
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(false);
  expect(r.cause).toBe("transient");
  expect(r.capabilities).toBeUndefined();
});

test("a null JSON line is ignored rather than crashing the parser", () => {
  expect(parseClaudeStream(`null\n${initLine(["Read"])}`).init?.tools).toEqual(["Read"]);
});

test("a background process the CLI leaves behind cannot hang the run: the drain is bounded", async () => {
  // The straggler holds the output pipes; stopping it is ENG-485, but the run must still return.
  // Its parent exits before the run's stop looks, so nothing stops it. It ends by itself once the
  // test's `done` file exists. To be claimed for cleanup by descent, it must still be a descendant
  // of this test when claimed: the fake CLI writes its pid, then waits for the `go` file.
  const dir = realpathSync(makeTempDir("styre-straggler-"));
  const [pidFile, go, done] = ["straggler.pid", "go", "done"].map((n) => join(dir, n));
  const cli = fakeCli(
    "claude-straggler",
    `${printLines([initLine(["Read"]), resultLine({ result: "ok" })])}\n( while [ ! -e '${done}' ] && [ -d '${dir}' ]; do sleep 0.05; done ) &\necho $! > '${pidFile}'\nwhile [ ! -e '${go}' ] && [ -d '${dir}' ]; do sleep 0.05; done\nexit 0`,
  );
  const since = nowToken();
  const start = Date.now();
  let r: Awaited<ReturnType<ReturnType<typeof claudeAgentRunner>["run"]>>;
  try {
    const run = claudeAgentRunner(cli).run({ ...runInput });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").endsWith("\n"));
    // Claimed by descent, for cleanup: it must succeed while the CLI waits for the go file.
    expect(ownPrinted(Number(readFileSync(pidFile, "utf8")), since)).not.toBeNull();
    writeFileSync(go, "");
    r = await run;
  } finally {
    writeFileSync(go, ""); // even when the run threw: the CLI and the straggler end by themselves
    writeFileSync(done, "");
    rmSync(dir, { recursive: true, force: true }); // every loop here also ends once it is gone
  }
  expect(Date.now() - start).toBeLessThan(9000); // the 5s drain bound; the straggler outlives it
  expect(r.completed).toBe(true);
  expect(r.stdout).toBe("ok");
}, 15000);

test("a detached leftover process holding the output pipe does not keep the runner alive", async () => {
  // python's setsid detaches the holder into a new session, so killing the CLI does not reach it.
  // It ends by itself once the test's `done` file exists (or after 20 s). To be claimed for cleanup
  // by descent, it must still be a descendant of this test when claimed: the CLI and the python
  // parent wait for the `go` file.
  const dir = realpathSync(makeTempDir("styre-holder-"));
  const [escaped, go, done] = ["holder-escaped.txt", "go", "done"].map((n) => join(dir, n));
  const cli = fakeCli(
    "claude-escaper",
    // The CLI exits only once the holder is established in its own session, outside the group.
    // The holder writes its own pid into the file the CLI waits for.
    `${printLines([initLine(["Read"]), resultLine({ result: "ok" })])}\npython3 -c 'import os,time\nif os.fork()==0:\n    os.setsid(); f=open("${escaped}.tmp","w"); f.write(str(os.getpid())); f.close(); os.rename("${escaped}.tmp","${escaped}")\n    t=time.time()\n    while not os.path.exists("${done}") and os.path.isdir("${dir}") and time.time()-t < 20: time.sleep(0.05)\nelse:\n    while not os.path.exists("${go}") and os.path.isdir("${dir}"): time.sleep(0.05)' &\nwhile [ ! -f '${escaped}' ] && [ -d '${dir}' ]; do sleep 0.05; done\nwhile [ ! -e '${go}' ] && [ -d '${dir}' ]; do sleep 0.05; done\nexit 0`,
  );
  const since = nowToken();
  const script = join(dir, "escaper-runner.ts");
  writeFileSync(
    script,
    `import { claudeAgentRunner } from ${JSON.stringify(join(import.meta.dir, "../../../src/agent/providers/claude.ts"))};
const r = await claudeAgentRunner(${JSON.stringify(cli)}).run({ prompt: "x", model: "m", allowedTools: ["Read"], cwd: ${JSON.stringify(cwd)}, timeoutMs: 10000 });
console.log(JSON.stringify({ completed: r.completed, stdout: r.stdout }));`,
  );
  const start = Date.now();
  let out = "";
  try {
    // Bun.spawn's default environment is the one Bun started with, which lacks the preload's test
    // state folder: pass this process's, so no launch record reaches the operator's real one (R29).
    const proc = Bun.spawn(["bun", "run", script], { env: { ...process.env }, stdout: "pipe" });
    const text = new Response(proc.stdout).text();
    await until(() => existsSync(escaped), 10_000);
    const holder = Number(readFileSync(escaped, "utf8"));
    // Claimed by descent, for cleanup: it must succeed while the CLI and python wait for go.
    expect(ownPrinted(holder, since, { pgid: holder })).not.toBeNull();
    writeFileSync(go, "");
    out = await text;
    await proc.exited;
  } finally {
    writeFileSync(go, ""); // even when something threw: everything here ends by itself
    writeFileSync(done, "");
    rmSync(dir, { recursive: true, force: true }); // every loop here also ends once it is gone
  }
  // drain timeout (5s) plus startup, well under the escaped holder's 20s
  expect(Date.now() - start).toBeLessThan(12000);
  expect(JSON.parse(out.trim().split("\n").pop() ?? "{}")).toEqual({
    completed: true,
    stdout: "ok",
  });
}, 20000);

test("a transcript line cut off by a crash is never read as the CLI's own message", async () => {
  // The CLI dies mid-write: the last line is an incomplete tool_result, not valid JSON.
  const cli = fakeCli(
    "claude-cut-line",
    `${printLines([initLine(["Read"])])}\nprintf '%s' '{"type":"user","message":{"content":[{"type":"tool_result","content":"notes: usage limit reached, resets DB_PASSWORD=hunter2 and more'\nkill -9 $$`,
  );
  const r = await claudeAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(false);
  expect(r.cause).toBe("transient");
  expect(r.resetAt).toBeNull();
  expect(JSON.stringify(r)).not.toContain("hunter2");
});
