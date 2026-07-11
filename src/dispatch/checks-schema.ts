import { z } from "zod";

/** One authored native check the plan-blind `checks:dispatch` agent wrote (control-loop §3a / M2
 *  design §4). The agent reports ONLY facts it knows because it wrote them — the target acceptance
 *  criterion, the NEW test file it created, and the test function/case name. It reports NO selector
 *  (runner-constructed, §5.2) and NO verdict (ground truth, §5). */
export const AuthoredCheckSchema = z.object({
  ac_id: z.number().int().positive(),
  test_file: z.string().min(1),
  test_name: z.string().min(1),
});

export type AuthoredCheck = z.infer<typeof AuthoredCheckSchema>;

/** The `checks:dispatch` structured-output contract. An absent/malformed sidecar is a transport
 *  failure (re-dispatch), not "no checks" (§4). The "≥1 authored check per AC" rule is a
 *  postcondition (design §8), enforced by the M2b handler — not by this schema (an empty array is
 *  well-formed). */
export const ChecksOutputSchema = z.object({
  checksAuthored: z.array(AuthoredCheckSchema),
  /** Any NON-test helper files (a fixture / conftest.py) the author created, so a legitimate helper
   *  is committed rather than rejected as scratch. Test files themselves are already in
   *  `checksAuthored[].test_file` and need not be repeated here. Absent/empty for the common case. */
  new_files: z.array(z.string()).default([]),
});

export type ChecksOutput = z.infer<typeof ChecksOutputSchema>;
