# Sphinx verification timeout: evidence and routing contract

The September 21 Linux validation used Styre `7de6515810dc03232191321d7d568867ac0b2184`
and bench `cc75f2c52efd40f218c4853f7686557c0064b331`. Its one Sphinx instance did not
resolve and did not open a PR. Oracle controls passed; measured run cost was $18.04264455.
This is one observation, not a causal comparison with the previous run.

## Observed failure

The unit test command began at 05:29:40.261 UTC and ended at 05:39:40.366 UTC.
The retained signal recorded `result=error`, `outcome=timed-out`, an executed command,
its candidate SHA, stdout, stderr, and truncation. The workflow step nevertheless
succeeded with an error result. The resolver excludes errors from completed verdicts,
so it requested that step again; the journal returned its saved result without execution.
The 200-tick escalation followed immediately. These were not 200 test executions.

## Contract implemented

- Completed zero/nonzero suite results retain their existing advisory behavior. Neither a
  nonzero exit nor a timeout alone establishes behavioral blame or baseline causality.
- Incomplete native suite execution retains diagnostics, then throws `StepExecutionError`.
  Both unit and integration checks retry the same operation, up to three attempts, then
  escalate for human intervention. They do not create a coding/reconciliation task.
- A persisted failed execution is routed through failure policy before another execution.
  Recovery records interrupted suite execution and preserves its consumed attempt count.
  Automatic restart cannot grant a fourth attempt after exhaustion.
- Explicit operator resume grants a fresh bounded window for failed execution or exhausted
  interrupted execution. The event ledger retains the previous attempt count and error.
  Successful checkpoints are not reset by this grant.
- If the resolver requests an already-completed journal step, stop with a specific no-progress
  escalation. This protects old inconsistent checkpoints without automatically repeating effects.
- Incomplete integration execution does not run a baseline comparison before escalation/retry.
  Native observations include elapsed duration and configured deadline; older observations
  remain readable with timing unknown. Bounded output capture retains the beginning and end
  of each stream, instead of retaining only the first 64 KiB.

## What consumed the deadline

The retained profile and signal specify bare `tox`. Python setup currently chooses that
command based on the presence of `tox.ini`. The public pre-fix Sphinx configuration has a
mixed default environment list: documentation, lint, typing, coverage, Python-version
variants, and docutils variants. Retained output confirms documentation installation/build
work (which failed after 19.14 seconds), a mypy Python-version error, and later test work.
The last live process observation showed active CPU work; it did not establish a hang.

There is insufficient evidence to allocate the full ten minutes by environment or identify
which test was active at the deadline. Earlier capture kept only the first 64 KiB, so the
last characters of that retained prefix were not necessarily the actual end of the log.
New timing and head/tail capture improve future observations but cannot reconstruct this run.

The next setup improvement is to qualify an explicit suite target. Do not increase the
limit or replace the command with `tox -e py` merely to make this instance finish: tox
Python environment names constrain interpreter selection, not test purpose. A durable
adapter must account for factors, inherited commands, dependencies, and tox version.
Ambiguous test intent must remain distinct from intentionally unavailable testing; simply
removing the command can currently degrade to reviewer-only verification. Explicit operator
commands must retain their intended semantics, including through Python environment reuse.
This change does not alter setup command selection, raise timeouts, or claim oracle success.

Sources: [Sphinx public pre-fix configuration](https://raw.githubusercontent.com/sphinx-doc/sphinx/2e506c5ab457cba743bb47eb5b8c8eb9dd51d23d/tox.ini),
[tox configuration](https://tox.wiki/en/4.29.0/config.html), and
[tox CLI environment selection](https://tox.wiki/en/4.29.0/cli_interface.html).
No held-out fix/test patch was inspected, and no additional benchmark was launched.
