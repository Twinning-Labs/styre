# Explicit suite selection after the Sphinx timeout

## Evidence and scope

The September 21 Sphinx validation selected bare `tox` because the repository had `tox.ini`.
Its ordinary pre-fix configuration declared documentation, lint, type checking, coverage,
and multiple Python/docutils environments. Retained output shows documentation installation/build
and mypy failures before further test activity. The old capture does not establish precisely
which phase consumed the 600-second deadline; see the companion timeout investigation.

A separate code path could silently replace any configured Python suite with `python -m pytest`
after an import check and successful pytest collection. Those observations do not establish
that pytest preserves tox/nox environments, flags, plugins, or a custom runner's behavior.

This change removes that substitution and requires explicit targets for recognized tox/nox
invocations. It contains no Sphinx-specific command, extra deadline, oracle change, or assumed
correct test environment.

## Contract

- A command is an executable string, `{ "unavailable": true }` (intentional absence), or
  `{ "unresolved": "reason" }` (selection still required). Unknown must not become unavailable.
- Deterministic Python discovery recognizes tox.ini, tox.toml, setup.cfg tox sections,
  pyproject tool.tox, and noxfile.py. Config presence establishes orchestration, not a test target.
- Setup retains unresolved intent through rejected discovery and blank interactive answers.
  It writes an inspectable profile and exits unsuccessfully if a primary target remains unknown.
- Discovery must use repository configuration, dependencies, and contributor instructions to
  propose concrete environments/sessions. A target's name alone does not establish test purpose.
- Runtime rejects unresolved primary commands and unselected recognized tox/nox invocations,
  including repository-wide commands. Legacy profiles remain readable and repairable; read-only
  inspection does not launch verification. Fixture components do not block primary execution.
- Ordinary setup preserves selected suite commands for the same repository and component
  name/kind/directory. `--force`/`--reprobe` deliberately recompute them. Test actions are derived
  again after command resolution rather than retained from an earlier proposal.
- Unit and integration verification execute the configured command verbatim. They retain native
  stdout/stderr, actual commit identity, exit status, and timing; failures are not converted to passes.

The target parser accepts a closed set of literal tox/nox invocation forms and options. Bare
runners, ALL, dynamic selectors, list/help/no-test/package-only options, and unsupported known
runner wrappers remain unresolved. This is not a general shell interpreter or a security sandbox.
An explicit repository script or make target is opaque; its meaning still needs repository evidence.

Selection is not proof of semantic correctness, interpreter availability, collection, completion,
or coverage of the ticket. A selected tox environment may have dependencies and a nox session may
expand or invoke other sessions. Existing execution bounds and evidence requirements still apply.

## Operator workflow

Inspect the repository's configuration and contributor instructions. Replace the generated
`commands.test.unresolved` object in the profile with the repository's concrete test command,
including required flags and config paths, then rerun ordinary setup. For example, a repository
that actually defines a test environment named `unit` can use `tox -e unit -- -q`; the example is
not a universal target recommendation. Keep unknown selection unresolved if the evidence is absent.

An existing bare-tox profile can be inspected and repaired without first passing runtime validation.
Do not use unavailable as a workaround for an unknown target.

## Sources

- [Sphinx pre-fix tox configuration](https://raw.githubusercontent.com/sphinx-doc/sphinx/2e506c5ab457cba743bb47eb5b8c8eb9dd51d23d/tox.ini)
- [tox configuration and discovery](https://tox.wiki/en/4.29.0/config.html)
- [tox command-line interface](https://tox.wiki/en/4.29.0/cli_interface.html)
- [nox session selection and execution](https://nox.thea.codes/en/stable/usage.html)
