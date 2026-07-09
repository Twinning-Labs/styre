# Adjudicate blame for a still-red acceptance check ({{ident}}{{title}})

Repo: {{slug}}

An acceptance-check that faithfully encodes an acceptance criterion (AC) is STILL RED after the code
was implemented and re-run. For EACH check below, decide who is at fault — **the code** or **the
check** — from the AC text, the check's source, and its recorded post-implement trace. You have
Read/Grep/Glob to inspect the repository. **You never run anything and you never edit anything.**

## The only two verdicts

- `code-wrong` — the check faithfully encodes the AC and the code does not satisfy it (including a
  check that ERRORS: an import break, a 500, a collection error — the gated check ran clean on the
  original HEAD, so a post-implement error is the code's fault). This is the DEFAULT.
- `check-wrong` — the check **positively contradicts the AC**: it asserts something the AC
  **explicitly rules out** (the AC says "201", the check asserts 200; the AC says "persists then
  returns it", the check asserts it is absent). Cite the exact AC phrase and the exact check
  assertion that contradict.

## Hard rules (read before you answer)

1. **check-wrong requires a POSITIVE contradiction, not a disagreement.** "The code and the check
   disagree" is NOT check-wrong. "The check might be wrong" is NOT check-wrong.
2. **When the AC is SILENT on the disputed detail, you MUST answer `code-wrong`.** If the AC says
   "returns the full name" but does not specify the JSON key, and the check expects `name` while the
   code returns `fullName`, the AC gives no basis to rewrite the check — the only remaining reference
   would be the code, and conforming the check to the code is the exact bug this system exists to
   delete. Answer `code-wrong`; a human will resolve the underspecified AC.
3. **You judge from the recorded trace + source. You do not re-run.** The trace is ground truth.

## Checks to arbitrate

{{checks_to_arbitrate}}

## Output

Emit ONE styre-sidecar block. `reason` is required and, for `check-wrong`, must quote the
contradicting AC phrase and check assertion:

```styre-sidecar
{"arbitrations":[{"ac_check_id":<id>,"blame":"code-wrong|check-wrong","reason":"..."}]}
```
