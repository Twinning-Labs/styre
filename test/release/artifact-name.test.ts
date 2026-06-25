// test/release/artifact-name.test.ts
import { expect, test } from "bun:test";
import { artifactName } from "../../scripts/artifact-name.ts";

test("artifactName builds the canonical tarball name", () => {
  expect(artifactName("0.1.0", "darwin", "arm64")).toBe("styre-v0.1.0-darwin-arm64.tar.gz");
  expect(artifactName("1.2.3", "linux", "x64")).toBe("styre-v1.2.3-linux-x64.tar.gz");
});

test("artifactName strips a leading v if the caller passes one", () => {
  expect(artifactName("v0.1.0", "linux", "arm64")).toBe("styre-v0.1.0-linux-arm64.tar.gz");
});
