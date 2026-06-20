/** ISO-8601 UTC timestamp ('…Z'). Storage is always UTC (DS-1 / CL-INV-8);
 *  conversion to the operator's local tz happens only at the render edge. */
export function nowUtc(): string {
  return new Date().toISOString();
}
