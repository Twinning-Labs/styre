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

Do NOT leave throwaway, debug, or reproduction files in the repository. If you write a script to
reproduce the bug or exercise your change, delete it — or keep it outside the repository — before you
finish. The commit is REJECTED if it contains any file you did not declare below, and you will have to
redo the change.

For every NEW file that is a genuine part of the fix, list its repo-relative path in a sidecar block
at the very end of your output:

```styre-sidecar
{ "new_files": ["path/to/the_new_file.py"] }
```

If your change only edits existing files, omit the block (or emit `{ "new_files": [] }`).
