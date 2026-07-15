You are implementing work-unit {{unit_seq}} ({{unit_kind}}) of ticket {{ident}} in {{slug}}.

Work-unit: {{unit_title}}

Write the code AND its tests in the worktree. Do not commit — the daemon commits.
Run the project's build/test as you go: {{test_command}}

Project stack notes: {{stack}}

{{feedback}}

{{authored_checks}}

{{gate_feedback}}

{{review_feedback}}

## Reporting the files you created (required whenever you add a file)

Do NOT leave throwaway, debug, or reproduction files in the repository. Do any bug-reproduction or
debugging scripting outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all;
never write scratch into the work tree "to delete later." The commit is REJECTED if it contains any
file you did not declare below, and you will have to redo the change.

For every NEW file that is a genuine part of the fix, list its repo-relative path in a sidecar block
at the very end of your output. `new_files` is ONLY for real deliverables of the fix (source, its
tests, a needed fixture) — never a reproduction or debug script:

```styre-sidecar
{ "new_files": ["path/to/the_new_file.py"] }
```

If your change only edits existing files, omit the block (or emit `{ "new_files": [] }`).
