import { expect, test } from "bun:test";
import {
  parseCargoToml,
  parseGemfile,
  parseGoMod,
  parsePyproject,
  parseRequirementsTxt,
} from "../../../src/setup/runtime-deps/parse.ts";

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

test("parseRequirementsTxt: directives/URLs skipped; extras/markers/direct-ref/VCS-egg handled", () => {
  const txt = [
    "# comment",
    "-r base.txt",
    "-e .",
    "--hash=sha256:abc",
    "https://example.com/pkg.whl",
    "uvicorn[standard]==0.20  # inline",
    "flask>=2.0 ; python_version<'3.9'",
    "requests",
    "pkg @ https://example.com/pkg.tar.gz",
    "git+https://github.com/psf/requests.git", // no #egg → unnameable, dropped (no junk)
    "-e git+https://github.com/foo/bar.git#egg=bar",
    "git+https://github.com/django/django.git@stable/4.2.x#egg=Django",
  ].join("\n");
  expect(parseRequirementsTxt(txt).sort()).toEqual(
    ["bar", "django", "flask", "pkg", "requests", "uvicorn"].sort(),
  );
});

test("parseGoMod: block + single-line requires, // indirect stripped", () => {
  const mod = [
    "module example.com/app",
    "go 1.22",
    "require github.com/jmoiron/sqlx v1.3.5",
    "require (",
    "\tgorm.io/gorm v1.25.0",
    "\tgo.uber.org/zap v1.26.0 // indirect",
    ")",
  ].join("\n");
  expect(parseGoMod(mod).sort()).toEqual(
    ["github.com/jmoiron/sqlx", "go.uber.org/zap", "gorm.io/gorm"].sort(),
  );
});

test("parseGemfile: gem lines only, comments ignored", () => {
  const gf = [
    "source 'https://rubygems.org'",
    "gem 'rails', '~> 7.0'",
    'gem "pg"',
    "# gem 'commented'",
    "group :test do",
    "  gem 'rspec'",
    "end",
  ].join("\n");
  expect(parseGemfile(gf).sort()).toEqual(["pg", "rails", "rspec"].sort());
});
