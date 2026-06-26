import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../../config/paths.ts";

export interface TelemetryState {
  distinctId: string;
  noticeShown: boolean;
}

function file(): string {
  return join(stateDir(), "telemetry.json");
}

function write(state: TelemetryState): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(state, null, 2)}\n`);
}

/** Read the persisted anonymous identity, or mint + persist one on first use. The distinct_id is a
 *  random UUID — never derived from machine/user/repo/key. */
export function loadOrCreateState(): TelemetryState {
  const p = file();
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as Partial<TelemetryState>;
      if (typeof s.distinctId === "string" && s.distinctId.length > 0) {
        return { distinctId: s.distinctId, noticeShown: Boolean(s.noticeShown) };
      }
    } catch {
      // corrupt file — fall through and regenerate
    }
  }
  const fresh: TelemetryState = { distinctId: randomUUID(), noticeShown: false };
  write(fresh);
  return fresh;
}

export function markNoticeShown(state: TelemetryState): void {
  if (!state.noticeShown) write({ ...state, noticeShown: true });
}
