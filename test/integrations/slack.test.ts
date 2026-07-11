import { expect, test } from "bun:test";
import { slackNotifier } from "../../src/integrations/adapters/slack.ts";

test("slackNotifier posts chat.postMessage with token+channel and returns the ts", async () => {
  const seen: { url: string; init: RequestInit } = { url: "", init: {} };
  const fakeFetch = async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), { status: 200 });
  };
  const port = slackNotifier({ token: "xoxb-abc", channel: "#styre", fetch: fakeFetch });
  const r = await port.notify({
    ticketIdent: "ENG-1",
    event: "escalated",
    severity: "high",
    reason: "step failed",
  });

  expect(r.ref).toBe("1700000000.000100");
  expect(seen.url).toBe("https://slack.com/api/chat.postMessage");
  expect((seen.init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-abc");
  const body = JSON.parse(seen.init.body as string) as { channel: string; text: string };
  expect(body.channel).toBe("#styre");
  expect(body.text).toContain("🔴");
  expect(body.text).toContain("ENG-1");
  expect(body.text).toContain("step failed");
});

test("slackNotifier throws when Slack returns ok:false", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
  const port = slackNotifier({ token: "t", channel: "#x", fetch: fakeFetch });
  await expect(port.notify({ ticketIdent: "ENG-1", event: "x", severity: "info" })).rejects.toThrow(
    /channel_not_found/,
  );
});

test("notify sends Block Kit blocks + a text fallback, with a PR button when prUrl is set", async () => {
  let body: { blocks: unknown[]; text: string } | undefined;
  const port = slackNotifier({
    token: "t",
    channel: "#x",
    fetch: async (_u, i) => {
      body = JSON.parse(i.body as string);
      return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200 });
    },
  });
  await port.notify({
    ticketIdent: "ENG-1",
    event: "PR ready to merge",
    severity: "success",
    ticketTitle: "Fix widget",
    prUrl: "https://gh/pr/42",
  });
  expect(Array.isArray(body?.blocks)).toBe(true);
  expect(typeof body?.text).toBe("string"); // fallback present
  const flat = JSON.stringify(body?.blocks);
  expect(flat).toContain("ENG-1");
  expect(flat).toContain("Fix widget");
  expect(flat).toContain("https://gh/pr/42"); // PR button url
});

test("notify throws a diagnosable error on a non-JSON / non-OK body", async () => {
  const port = slackNotifier({
    token: "t",
    channel: "#x",
    fetch: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  });
  await expect(port.notify({ ticketIdent: "ENG-1", event: "x", severity: "info" })).rejects.toThrow(
    /502/,
  );
});

test("notify throws a diagnosable non-JSON error on an HTTP-200 non-JSON body", async () => {
  const port = slackNotifier({
    token: "t",
    channel: "#x",
    fetch: async () => new Response("not json at all", { status: 200 }),
  });
  await expect(port.notify({ ticketIdent: "ENG-1", event: "x", severity: "info" })).rejects.toThrow(
    /non-JSON/i,
  );
});
