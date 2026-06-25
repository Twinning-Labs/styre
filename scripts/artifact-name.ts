// scripts/artifact-name.ts
export function artifactName(
  version: string,
  os: "darwin" | "linux",
  arch: "arm64" | "x64",
): string {
  const v = version.replace(/^v/, "");
  return `styre-v${v}-${os}-${arch}.tar.gz`;
}

if (import.meta.main) {
  const [version, os, arch] = process.argv.slice(2);
  if (!version || !os || !arch) {
    process.stderr.write("usage: artifact-name.ts <version> <darwin|linux> <arm64|x64>\n");
    process.exit(2);
  }
  process.stdout.write(artifactName(version, os as "darwin" | "linux", arch as "arm64" | "x64"));
}
