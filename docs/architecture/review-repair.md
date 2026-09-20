# Review, repair, and risk acceptance

Styre treats a review finding as a claim to investigate. A nomination for deferral is not permission
to ship. Every open major or critical code finding blocks progression until a separate review
resolves it or the operator explicitly accepts an eligible major risk.

## Structured contracts

Code-review output contains `findings`, `resolutions`, and `verification_requests`. Every prior
unresolved finding ID must occur exactly once in `resolutions`, with disposition `fixed`, `invalid`,
or `unresolved`, a nonblank rationale, and at least one citation. New findings use the existing
severity/category/location/unit fields. The runner validates the complete output before closing
old findings or inserting new ones, in the same transaction as the successful workflow step.
A missing or malformed response cannot act as a clean review.

Implementation output adds `review_responses`: each finding assigned to that unit must be answered
exactly once as `repaired` or `disputed`, with rationale and citations. Ticket-wide findings go to
the first work unit; all units still re-verify. Author responses are claims, not closing verdicts.
Source citations must survive the implementation commit; discarded-file citations fail and roll
back the attempt. The separate reviewer receives the finding ledger and recorded author responses.

Citation types are repository-relative source path plus positive line number, a persisted same-ticket
measurement ID at the relevant SHA, or an HTTP(S) reference URL. Source paths cannot escape through
symlinks. The runner checks existence and provenance, not semantic truth: a cited URL is not fetched
or endorsed automatically. The reviewer must assess whether the cited material supports the claim.

Plan review rejects every deferral nomination. Ordinary critical/major plan findings route to redesign;
code findings categorized `plan-defect` retain the configured `onPlanDefect` behavior. Redesign
detaches code findings from replaced work units so their IDs and resolution obligations survive. Resolver guards
prevent a succeeded but unresolved plan review from advancing after resume.

## Controlled verification

Review agents keep their read-only tool allowance. They can request one job ID from the runner's
catalog of configured component test commands. IDs hash the command, component directory and index;
an unknown ID or a mixed request-plus-verdict fails validation. The runner executes the exact job
from a realpath-confined worktree directory using the credential-scrubbed verification environment.
It records command, SHA, exit code, output, timeout, truncation, and worktree mutation status.
Exit zero establishes command execution, not that a specific assertion ran or passed.

The entire process/pipe lifetime is bounded by the review timeout. Each captured stream is capped
at 65,536 characters and continues draining after the cap. POSIX process groups allow cleanup of
ordinary descendants, including descendants holding pipes open after the shell exits. The journal
stores the negative group PID while a probe runs so crash recovery can kill that group. This is
not an OS sandbox against deliberately hostile repository commands.

A probe that dirties the worktree records an error and restores tracked changes/removes newly
created untracked files, preserving pre-existing untracked files. A moved HEAD requires operator
repair. Timeout records an error and escalates. The reviewer receives retained measurements on its
next dispatch, including any reported failure; it cannot invent the command or the recorded result.

## Bounds and checkpoints

At most three automatic review-origin loopbacks occur per ticket, across plan/code review and
resume. The existing consecutive-identical finding signature guard can escalate earlier. At most
three verification requests are executed per ticket; intent is recorded before execution, so a
crash still consumes the allowance. Existing transport retry and overall run bounds remain in force.
These limits are not monetary spending ceilings.

On first use, a `review-contract-started` event snapshots legacy findings superseded by a proven
completed latest review. A dispatch row alone is not proof: the legacy workflow step must have
succeeded and its recorded finding count must match its latest dispatch ledger. Ambiguous legacy
history retains open debt. The snapshot uses finding ID plus dispatch ID so SQLite ID reuse cannot
hide a later finding. After that boundary, every unresolved major/critical persists across later
failed, empty, or interrupted dispatches until explicitly resolved. Legacy `blocks_ship=0` does
not exempt an open major finding.

## Resume and shipping

Plain resume and `--review-action retry` retain unresolved findings and apply the review routing
policy again. They never accept risk. Retry may immediately pause again for no progress. A changed
code HEAD accepted with `--accept-head` re-enters implementation and verification; a changed plan
HEAD re-enters design. This explicit operator intervention does not reset the recorded limits.
Retry refuses pending forge effects rather than allowing an old queued push to race a repair.

To accept risk, use `--resume --review-action accept-risk --review-findings 12,13
--review-reason 'reason for accepting these risks'`. This requires a completed current code review
paused in review, unchanged reviewed HEAD, and exactly all unresolved IDs. Every accepted finding
must be a nominated major; critical findings and plan findings cannot be accepted. Partial acceptance,
foreign or duplicate IDs, empty rationale, and incomplete provenance are refused before resume
mutates workflow state. Signal consumption, disposition changes, and the audit event commit together.
The branch HEAD is rechecked immediately before that transaction.

Acceptance is tied to its SHA and includes the finding snapshot. A different HEAD invalidates it.
The resolver, merge handlers, and forge outbox drainer all reject unresolved debt or stale acceptance.
Production pushes use the recorded reviewed SHA as the refspec source, rather than a movable local
branch name. PR descriptions disclose the accepted finding IDs, locations, SHA and operator rationale
and omit the unconditional independent-review assurance when risks were accepted.
