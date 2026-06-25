// scripts/render-formula.ts
import { artifactName } from "./artifact-name.ts";

const BASE = "https://github.com/Twinning-Labs/styre/releases/download";

export interface FormulaShas {
  darwinArm64: string;
  darwinX64: string;
  linuxArm64: string;
  linuxX64: string;
}

function url(version: string, os: "darwin" | "linux", arch: "arm64" | "x64"): string {
  const v = version.replace(/^v/, "");
  return `${BASE}/v${v}/${artifactName(v, os, arch)}`;
}

function assertSha(label: string, sha: string): void {
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`invalid sha256 for ${label}: ${sha}`);
  }
}

export function renderFormula(version: string, shas: FormulaShas): string {
  const v = version.replace(/^v/, "");
  assertSha("darwin-arm64", shas.darwinArm64);
  assertSha("darwin-x64", shas.darwinX64);
  assertSha("linux-arm64", shas.linuxArm64);
  assertSha("linux-x64", shas.linuxX64);
  return `class Styre < Formula
  desc "Open-source autonomous-SDLC execution core"
  homepage "https://github.com/Twinning-Labs/styre"
  version "${v}"
  license "GPL-3.0-or-later"

  on_macos do
    on_arm do
      url "${url(v, "darwin", "arm64")}"
      sha256 "${shas.darwinArm64}"
    end
    on_intel do
      url "${url(v, "darwin", "x64")}"
      sha256 "${shas.darwinX64}"
    end
  end

  on_linux do
    on_arm do
      url "${url(v, "linux", "arm64")}"
      sha256 "${shas.linuxArm64}"
    end
    on_intel do
      url "${url(v, "linux", "x64")}"
      sha256 "${shas.linuxX64}"
    end
  end

  def install
    bin.install "styre"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/styre --version")
  end
end
`;
}

if (import.meta.main) {
  const [version, da, dx, la, lx] = process.argv.slice(2);
  if (!version || !da || !dx || !la || !lx) {
    process.stderr.write(
      "usage: render-formula.ts <version> <darwinArm64Sha> <darwinX64Sha> <linuxArm64Sha> <linuxX64Sha>\n",
    );
    process.exit(2);
  }
  process.stdout.write(
    renderFormula(version, { darwinArm64: da, darwinX64: dx, linuxArm64: la, linuxX64: lx }),
  );
}
