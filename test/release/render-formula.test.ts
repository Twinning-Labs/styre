// test/release/render-formula.test.ts
import { expect, test } from "bun:test";
import { renderFormula } from "../../scripts/render-formula.ts";

const SHAS = {
  darwinArm64: "a".repeat(64),
  darwinX64: "b".repeat(64),
  linuxArm64: "c".repeat(64),
  linuxX64: "d".repeat(64),
};

test("renderFormula embeds version, license, and all four url/sha pairs", () => {
  const f = renderFormula("0.1.0", SHAS);
  expect(f).toContain("class Styre < Formula");
  expect(f).toContain('license "GPL-3.0-or-later"');
  expect(f).toContain('version "0.1.0"');
  // urls
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-darwin-arm64.tar.gz");
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-linux-x64.tar.gz");
  // the two middle slices (guard against a darwin-x64 / linux-arm64 transposition)
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-darwin-x64.tar.gz");
  expect(f).toContain("releases/download/v0.1.0/styre-v0.1.0-linux-arm64.tar.gz");
  expect(f).toContain(`sha256 "${"b".repeat(64)}"`);
  expect(f).toContain(`sha256 "${"c".repeat(64)}"`);
  // shas, one per slice
  expect(f).toContain(`sha256 "${"a".repeat(64)}"`);
  expect(f).toContain(`sha256 "${"d".repeat(64)}"`);
  // structure
  expect(f).toContain("on_macos do");
  expect(f).toContain("on_linux do");
  expect(f).toContain('bin.install "styre"');
  expect(f).toContain("test do");
});

test("renderFormula rejects a non-64-hex sha", () => {
  expect(() => renderFormula("0.1.0", { ...SHAS, linuxX64: "short" })).toThrow();
});
