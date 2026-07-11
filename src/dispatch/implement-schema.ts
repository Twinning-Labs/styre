import { z } from "zod";

/** implement:dispatch structured-output contract (control-loop §3a). The agent lists every NEW file
 *  it created as part of the fix so the runner can commit them by name; throwaway/debug files must
 *  NOT appear here and must not be left in the repo. Lenient: absent/empty means "no new files" (a
 *  pure-edit fix). An absent sidecar is NOT a transport failure for implement (unlike checks). */
export const ImplementOutputSchema = z.object({
  new_files: z.array(z.string()).default([]),
});

export type ImplementOutput = z.infer<typeof ImplementOutputSchema>;
