/**
 * Reading a command's output pipe (ENG-485 section 6.2). The read runs while the command runs, so a
 * large output cannot fill the pipe and stall the command. After the command's group has been
 * stopped, `finish` waits for the rest of the output for at most `limitMs`; whatever is still
 * unread then is dropped, so a holder of the pipe that survived can never hang the caller.
 */
export const DRAIN_LIMIT_MS = 5_000;

export interface PipeReader {
  /** Wait for the pipe to end, up to `limitMs`. Resolves true if the whole output was read, false if
   *  the limit was reached and the rest was dropped. */
  finish(limitMs: number): Promise<boolean>;
  /** Stop reading at once and drop the rest. */
  cancel(): void;
}

export function readPipe(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): PipeReader {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let ended = false;
  const done = (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        onText(decoder.decode(r.value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) onText(tail);
    } catch {
      /* a cancelled or broken pipe ends the read */
    } finally {
      ended = true;
    }
  })();
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  return {
    cancel,
    finish: async (limitMs) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"limit">((resolve) => {
        timer = setTimeout(() => resolve("limit"), limitMs);
      });
      const r = await Promise.race([done.then(() => "done" as const), timedOut]);
      clearTimeout(timer);
      if (r === "limit") {
        cancel();
        await done; // a cancelled read ends promptly
        return false;
      }
      return ended;
    },
  };
}
