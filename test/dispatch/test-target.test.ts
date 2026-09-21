import { expect, test } from "bun:test";
import { assertResolved } from "../../src/cli/run.ts";
import { commandFor, isUnavailable } from "../../src/dispatch/components.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { assertTestTargets, testTargetProblem } from "../../src/dispatch/test-target.ts";

for (const command of [
  "tox",
  't"ox"',
  'n"ox"',
  "to\\x",
  "'t'ox",
  't"ox" && echo done',
  "tox\n-e unit",
  "tox -e unit\ntox",
  "tox -e unit #comment\ntox",
  'env -i t"ox"',
  'timeout 60 t"ox"',
  "tox run",
  "python -m tox",
  "python3 -m tox run",
  "/opt/venv/bin/tox",
  "uv run tox",
  "uvx tox",
  "env TOXENV=py311 tox",
  "nox",
  "python -m nox",
  "tox -- -e py311",
  "tox -e ALL",
  "tox -e py{310,311}",
  'tox -e "$TARGET"',
  "tox -e",
  "tox --envlist=",
  "tox -e py311 -n",
  "tox -e py311 --notest",
  "tox -e py311 --pkg-only",
  "tox -e py311 --help",
  "tox list -e py311",
  "tox --result-json -e py311",
  "nox -s",
  "nox -s tests --list",
  "nox -k tests",
  'sh -c "tox"',
  "tox && echo success",
  "nox --session=",
  "tox -e 'py311, py312'",
])
  test(`unqualified orchestration cannot start: ${command}`, () =>
    expect(testTargetProblem(command)).not.toBeNull());

for (const command of [
  "tox -e py311",
  "tox --envlist=py311,py312",
  "tox -epy311",
  "tox run -e unit -- -q",
  "python3 -m tox -c sub/tox.ini -e unit",
  "uv run tox -e unit",
  "/opt/venv/bin/tox -e unit",
  "nox -s tests",
  "nox --session tests lint -- --flag",
  "nox --session=tests",
  "python -m nox -f sub/noxfile.py -s tests",
  "pytest tests/unit -q",
  "python -m pytest -m slow",
  "python ./tests/runtests.py --parallel 1",
  "make test",
  "sh ./test.sh",
])
  test(`explicit command is preserved: ${command}`, () =>
    expect(testTargetProblem(command)).toBeNull());

function profile(testCommand: unknown) {
  return parseProfile({
    slug: "test",
    targetRepo: "/repo",
    components: [
      {
        name: "python",
        kind: "python",
        paths: ["**"],
        commands: { build: { unavailable: true }, check: { unavailable: true }, test: testCommand },
      },
    ],
  });
}

test("legacy unselected profiles remain readable but cannot execute", () => {
  const p = profile("tox");
  expect(() => assertResolved(p)).toThrow(/Unresolved test targets/);
});

test("unresolved is not unavailable and command consumers fail loudly", () => {
  const p = profile({ unresolved: "Select the suite" });
  expect(isUnavailable(p.components[0], "test")).toBe(false);
  expect(() => commandFor(p.components[0], "test")).toThrow("Select the suite");
  expect(() => assertResolved(p)).toThrow("Select the suite");
});

test("fixture ambiguity is ignored by target readiness; repository-wide commands cannot bypass it", () => {
  const p = profile("tox");
  p.components[0].role = "fixture";
  expect(() => assertTestTargets(p)).not.toThrow();
  p.repoCommands.integration = "tox";
  expect(() => assertTestTargets(p)).toThrow(/repo.integration/);
  p.repoCommands.integration = "tox -e unit";
  expect(() => assertTestTargets(p)).not.toThrow();
});
