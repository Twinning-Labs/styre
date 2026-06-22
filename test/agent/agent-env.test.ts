import { expect, test } from "bun:test";
import { agentEnv } from "../../src/agent/providers/claude.ts";

test("agentEnv strips the daemon-held creds, keeps everything else", () => {
  const out = agentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    LINEAR_API_KEY: "secret-linear",
    GITHUB_TOKEN: "secret-gh",
    SOME_OTHER: "keep",
    UNDEF: undefined,
  });
  expect(out.PATH).toBe("/usr/bin");
  expect(out.HOME).toBe("/home/x");
  expect(out.SOME_OTHER).toBe("keep");
  expect("LINEAR_API_KEY" in out).toBe(false);
  expect("GITHUB_TOKEN" in out).toBe(false);
  expect("UNDEF" in out).toBe(false);
});
