/** Build a globally-unique-by-construction idempotency key (control-loop §3).
 *  `prefix` is the caller's unique id (the future dispatch_id / ticket ident);
 *  `suffix` names the effect (e.g. "push", "pr_create"). The schema's UNIQUE
 *  indexes on idempotency_key are the actual dedup mechanism. */
export function idempotencyKey(prefix: string, suffix: string): string {
  if (!prefix) {
    throw new Error("idempotencyKey: prefix required");
  }
  if (!suffix) {
    throw new Error("idempotencyKey: suffix required");
  }
  return `${prefix}-${suffix}`;
}
