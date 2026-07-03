/** True iff `command` is free of shell metacharacters that would let an agent-authored string do
 *  more than invoke one program with literal args. This is HYGIENE, NOT A SANDBOX: an interpreter
 *  first-token (`node -e "…"`) is still arbitrary code (see the plan's Residual Risks). It is the
 *  persistence-time gate that stops the common `pytest; curl … | sh` / `…/$SECRET` exfil payloads
 *  (F1). Verify still runs the (metachar-free) string via `sh -c`. */
const FORBIDDEN = [";", "&", "|", "`", "$", "(", ")", "<", ">", "\n", "\r"];

export function isCommandSafe(command: string): boolean {
  return !FORBIDDEN.some((tok) => command.includes(tok));
}
