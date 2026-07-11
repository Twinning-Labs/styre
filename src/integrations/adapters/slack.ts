import type { NotificationMessage, NotifierPort } from "../notifier.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const EMOJI: Record<NotificationMessage["severity"], string> = {
  high: "🔴",
  success: "🟢",
  info: "▸",
};

/** Slack adapter: posts one message per notification via chat.postMessage. Token + channel are
 *  passed in (token originates from SLACK_BOT_TOKEN in env, resolved in makeProjectorPorts).
 *  `fetch` is injectable for tests. Renders Block Kit (with a `text` fallback for notifications)
 *  and a "View PR" button when `prUrl` is set. */
export function slackNotifier(opts: {
  token: string;
  channel: string;
  fetch?: FetchLike;
}): NotifierPort {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  return {
    async notify(msg) {
      const emoji = EMOJI[msg.severity];
      const title = msg.ticketTitle ? ` — ${msg.ticketTitle}` : "";
      const headline = `${emoji} *${msg.ticketIdent}*${title}`;
      const bodyLine = `*${msg.event}*${msg.reason ? `\n${msg.reason}` : ""}`;
      const text = `${emoji} ${msg.ticketIdent}${title} ${msg.event}${msg.reason ? `: ${msg.reason}` : ""}`; // notification fallback
      const blocks: Record<string, unknown>[] = [
        { type: "section", text: { type: "mrkdwn", text: `${headline}\n${bodyLine}` } },
      ];
      if (msg.prUrl) {
        blocks.push({
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "View PR" }, url: msg.prUrl },
          ],
        });
      }
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ channel: opts.channel, blocks, text }),
      });
      const raw = await res.text();
      if (!res.ok)
        throw new Error(`slack chat.postMessage HTTP ${res.status}: ${raw.slice(0, 200)}`);
      let data: { ok: boolean; ts?: string; error?: string };
      try {
        data = JSON.parse(raw) as { ok: boolean; ts?: string; error?: string };
      } catch {
        throw new Error(
          `slack chat.postMessage returned non-JSON (HTTP ${res.status}): ${raw.slice(0, 120)}`,
        );
      }
      if (!data.ok)
        throw new Error(`slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
      return { ref: data.ts ?? "" };
    },
  };
}
