# Documentation sync — {{ident}} {{title}}

The implementation for this ticket is complete and committed in this worktree, and it has already
passed the project's verification. Your job is to update the project's **documentation** so it
reflects the change — nothing else.

Read, to understand what changed:
- the implementation plan under `docs/plans/` for this ticket ({{ident}}),
- the changed source in the worktree,
- the existing documentation.

Then update the documentation to match: public API/behavior changes, new or changed options, and
any user-facing notes or changelog entry the change warrants.

Hard rules:
- Edit **only** documentation: {{doc_paths}}. Do NOT edit source, tests, or configuration — a
  commit that touches anything else will be rejected and this step retried.
- If the change needs no documentation update, make **no changes** and finish. That is a valid,
  common outcome — do not invent edits.
- Do not run commands; you have no shell. Read the worktree and the plan directly.
