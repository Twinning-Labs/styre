import { expect, test } from "bun:test";
import { parseCargoToml, parsePyproject } from "../../../src/setup/runtime-deps/parse.ts";

test("parseCargoToml: normal, inline-table, sub-table, target, dev deps", () => {
  const toml = [
    "[dependencies]",
    'serde = "1.0"',
    'tokio = { version = "1", features = ["full"] }',
    "[dependencies.diesel]",
    'version = "2"',
    "[build-dependencies]",
    'cc = "1"',
    "[dev-dependencies]",
    'mockall = "0.11"',
    "[target.'cfg(unix)'.dependencies]",
    'nix = "0.27"',
  ].join("\n");
  expect(parseCargoToml(toml).sort()).toEqual(
    ["cc", "diesel", "mockall", "nix", "serde", "tokio"].sort(),
  );
});

test("parseCargoToml: [features] is not mistaken for deps", () => {
  const toml = '[dependencies]\nserde = "1"\n[features]\ndefault = ["serde"]\nextra = []\n';
  expect(parseCargoToml(toml)).toEqual(["serde"]);
});

test("parseCargoToml: malformed → []", () => {
  expect(parseCargoToml("this is not [ valid toml =")).toEqual([]);
});

test("parsePyproject: PEP 621 deps with extras/markers, optional, poetry, groups; python filtered", () => {
  const toml = [
    "[project]",
    'dependencies = ["sqlalchemy[asyncio]>=2.0", "django ; python_version<\'3.9\'"]',
    "[project.optional-dependencies]",
    'dev = ["pytest>=7"]',
    "[tool.poetry.dependencies]",
    'python = "^3.11"',
    'fastapi = "^0.110"',
    "[tool.poetry.group.test.dependencies]",
    'httpx = "*"',
  ].join("\n");
  expect(parsePyproject(toml).sort()).toEqual(
    ["django", "fastapi", "httpx", "pytest", "sqlalchemy"].sort(),
  );
});

test("parsePyproject: malformed → []", () => {
  expect(parsePyproject("[project\nbad")).toEqual([]);
});
