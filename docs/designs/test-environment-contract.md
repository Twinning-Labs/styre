# Test environment intent and host qualification

Setup used to infer a framework from a filename or wrapper, without measuring which
interpreter, dependency installation, or source tree the wrapper would use. That
failed both in prepared Sphinx and in ordinary Node projects: a pnpm install could
be followed by an npm test command, nested scripts were probed from the repository
root, and missing test discovery could silently become “testing unavailable.”

This change separates three contracts:

1. **Portable intent** (`component.testEnvironment`, version 1): managed or existing
   environment policy, exact suite command, supported framework and single-check
   launcher, and the Node package manager/install owner where applicable.
2. **Host observation**: runtime executable/version, framework packages, source
   revision and binding, configuration/lock-content fingerprint, bounded probe
   stdout/stderr and collection outcome. Setup writes a private
   `<profile>.environment.json` inventory; it is not a transferable readiness claim.
3. **Execution evidence**: fresh qualification at provisioning and consumer gates,
   including resumed design/check/implementation/review/verification. Individual
   checks and baseline replay qualify their actual checkout and retain that
   observation separately from the frozen check plan's original fingerprint.

## Operator behavior

`styre setup --repo /path/to/repo --test-environment managed` is the default.
Provision executes the recorded prepare command, then qualifies the environment.
Selected managed tox environments are prepared with `--notest`. Existing successful
provision steps do not authorize stale host evidence after resume.

`styre setup --repo /path/to/repo --test-environment existing` explicitly requests
reuse without install/sync actions. Merely finding tox-current-env never chooses
this policy. For an unresolved Python tox target, setup can propose the target that
matches the observed Python version only after resolving its effective tox config.
The current-env adapter requires observed tox 4 and its plugin. Provision and
execution still qualify that proposal on the actual checkout.

Old profiles remain parseable and inspectable. Executing Python/Node test commands
through `styre run` requires regenerating their environment plans. Setup preserves
explicit commands on ordinary reruns; an unsupported old command remains visible
with a reason, rather than being rewritten into a guessed substitute. `--force`
resets discovery. Existing no-test declarations remain explicit operator intent.

## States and boundaries

- `inventory/ready` means the runtime inventory was read, not that tests passed.
- `qualification/ready` means supported execution prerequisites were observed.
- `empty` means collection completed with zero tests; authors may add first tests.
- `requires-preparation` means a runtime/package/source prerequisite is missing.
- `unsupported` means no defined adapter can preserve the selected context.
- `error` means the configuration, probe, timeout, or collection failed.

Environment problems raise bounded execution errors and record a test-environment
signal before dispatching the consumer. They are not behavioral REDs, reviewer
findings, or oracle success. Probe operations are bounded (5–60 seconds), credential
scrubbed with the existing verify policy, and preserve capped diagnostics. Collection
loads repository configuration and modules; it is not a security sandbox or proof
that the test bodies pass.

## Supported execution contexts

Python supports explicit `python[3[.N]] -m pytest` with options that change only what
pytest prints (`-q`/`-v` repeated, `--verbose`, `--strict-markers`, `-r<chars>`,
`--durations N`, `--no-header`). Options that select tests, stop early, load plugins or
rewrite configuration stay unsupported, as does `--tb`: `--tb=no` removes the `E` assertion
lines that behavioral-failure evidence counts. Python also supports the repository's Django
runner and one selected `python3 -m tox -e pyNN` context. Managed tox currently expects its default `.tox/pyNN/bin/python` layout.
Existing tox uses `--current-env --no-provision`. Resolved tox must preserve failure status, run
one pytest command, forward a sentinel selector without extra default paths or
filters, and have no pre/post commands or dependent environments. A temporary
collection-only Python module observes the interpreter, packages, and source **inside
that launcher**, so outer-shell imports cannot stand in for tox's actual context.
Source binding is checked when an import name is derivable; receipts explicitly say
when it is not. Namespace packages and unconventional distribution/import mappings
need further adapters; no unconditional source-binding claim is made for them.

Node supports literal Jest, Vitest, and Mocha package scripts with a closed set of
configuration flags. It preserves the original package-script wrapper and lifecycle
context. A unique `test:*` script can be selected deterministically; competing
suites remain unresolved. Install ownership follows actual package.json/pnpm
workspace membership and exclusions, while tests execute from the component.
Manager declarations and lockfiles must agree, and declared versions must match.

Arbitrary shell wrappers, lifecycle hooks, Yarn PnP, nox, multi-environment tox,
framework-specific filtering, and `vitest run` script bodies currently fail with an
explicit unsupported reason. In particular, rewriting `npm run test` to `npm exec`
would change npm lifecycle variables, and appending `list` or another `run` to a
`vitest run` wrapper would not preserve its protocol. These require defined adapters,
not command substitution. Other language adapters retain their existing behavior.

## Validation and sources

Regression fixtures cover malformed plans, runtime mismatch, source shadowing,
selector forwarding, collection errors/timeouts/empty suites, manager conflicts,
workspace exclusions, named scripts, fresh resumed gates, and observation identity.
Native Linux fixtures exercise pytest 8.3.3, Jest 29.7.0, Vitest 2.1.9, and Mocha
10.8.2. The native CI job also exercises these contracts with its existing
pytest 8.3.5 / Mocha 10.2.0 pins, plus Jest 29.7.0 and Vitest 2.1.9. Sphinx validation uses its ordinary baseline checkout and collection only;
no held-out patches, benchmark run, or test-body/oracle success is implied.

- [tox-current-env 0.0.11](https://pypi.org/project/tox-current-env/0.0.11/)
- [npm script environment](https://docs.npmjs.com/cli/v11/using-npm/scripts/)
- [Vitest list protocol](https://v2.vitest.dev/guide/cli)
- [Corepack package-manager declaration](https://github.com/nodejs/corepack/blob/main/README.md)
- [uv synchronization and execution](https://docs.astral.sh/uv/concepts/projects/sync/)
