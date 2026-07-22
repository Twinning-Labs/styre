import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexArgs,
  codexAgentRunner,
  parseCodexUsage,
  sandboxForTools,
} from "../../../src/agent/providers/codex.ts";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-codex-")));

function fakeCli(name: string, body: string): string {
  const path = join(cwd, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const runInput = { prompt: "hi", model: "m", allowedTools: ["Read"], cwd, timeoutMs: 5000 };

test("sandboxForTools maps read-only vs write and web access", () => {
  expect(sandboxForTools(["Read", "Grep", "Glob"])).toEqual({ mode: "read-only", network: false });
  expect(sandboxForTools(["Read", "Write", "Edit", "Bash(pytest:*)"])).toEqual({
    mode: "workspace-write",
    network: false,
  });
  // design:dispatch: write + web → workspace-write with network restored (DEC-CX-3)
  expect(sandboxForTools(["Read", "Write", "WebSearch", "WebFetch"])).toEqual({
    mode: "workspace-write",
    network: true,
  });
});

test("buildCodexArgs puts global flags before exec, adds --search + ownership flags", () => {
  const args = buildCodexArgs({
    model: "gpt-x",
    allowedTools: ["Read", "Write", "WebFetch"],
    cwd: "/wt",
    outputPath: "/tmp/out.txt",
  });
  const s = args.join(" ");
  // GLOBAL flags must precede the subcommand (installed CLI rejects `codex exec --ask-for-approval`)
  expect(args[0]).toBe("--ask-for-approval");
  expect(args[1]).toBe("never");
  expect(args.indexOf("exec")).toBeGreaterThan(args.indexOf("never"));
  expect(args.indexOf("--search")).toBeLessThan(args.indexOf("exec")); // --search is global too
  expect(s).toContain("--model gpt-x");
  expect(s).toContain("--cd /wt");
  expect(s).toContain("--sandbox workspace-write");
  expect(s).toContain("--skip-git-repo-check");
  expect(s).toContain("--ephemeral");
  expect(s).toContain("--ignore-user-config");
  expect(s).toContain("--ignore-rules");
  expect(s).toContain("-o /tmp/out.txt");
  expect(s).toContain("-c sandbox_workspace_write.network_access=true");
  expect(args[args.length - 1]).toBe("-"); // prompt on stdin
});

test("buildCodexArgs omits --search + network override for a read-only dispatch", () => {
  const args = buildCodexArgs({ model: "m", allowedTools: ["Read"], cwd: "/wt", outputPath: "/o" });
  const s = args.join(" ");
  expect(s).toContain("--sandbox read-only");
  expect(s).not.toContain("--search");
  expect(s).not.toContain("network_access");
  expect(args.indexOf("exec")).toBeGreaterThan(args.indexOf("--ask-for-approval"));
});

test("parseCodexUsage reads turn.completed usage from the JSONL stream", () => {
  const jsonl = [
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}',
  ].join("\n");
  const u = parseCodexUsage(jsonl);
  expect(u.tokensIn).toBe(24763);
  expect(u.tokensOut).toBe(122);
  expect(u.cacheRead).toBe(24448);
  expect(u.costUsd).toBeNull();
  expect(parseCodexUsage("garbage\n{bad").tokensIn).toBeNull();
});

test("run reads the final message from --output-last-message and parses usage", async () => {
  // fake codex: extract the -o path from argv, write the final message there, emit JSONL on stdout
  const cli = fakeCli(
    "codex-ok",
    [
      "out=",
      'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done',
      "printf '%s' 'done\n```styre-sidecar\n{\"n\":5}\n```' > \"$out\"",
      `echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":7}}'`,
    ].join("\n"),
  );
  const r = await codexAgentRunner(cli).run({ ...runInput });
  expect(r.completed).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("```styre-sidecar");
  expect(r.tokensIn).toBe(10);
  expect(r.cacheRead).toBe(7);
  expect(r.costUsd).toBeNull();
});

test("run SIGKILLs and returns promptly on a process that traps SIGTERM and hangs", async () => {
  const cli = fakeCli("codex-hang", "trap '' TERM\nsleep 30");
  const start = Date.now();
  const r = await codexAgentRunner(cli).run({ ...runInput, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.completed).toBe(false);
  expect(Date.now() - start).toBeLessThan(5000);
  expect(r.cause).toBe("transient");
});

test("parseCodexUsage reads cache_write_input_tokens into cacheCreate", () => {
  const line =
    '{"type":"turn.completed","usage":{"input_tokens":51599,"cached_input_tokens":36339,"cache_write_input_tokens":15248,"output_tokens":267}}';
  const u = parseCodexUsage(line);
  expect(u.cacheCreate).toBe(15248);
  expect(u.cacheRead).toBe(36339);
  expect(u.tokensIn).toBe(51599);
});

test("parseCodexUsage: absent cache_write_input_tokens → cacheCreate null", () => {
  const line =
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3,"cached_input_tokens":7}}';
  expect(parseCodexUsage(line).cacheCreate).toBeNull();
});
