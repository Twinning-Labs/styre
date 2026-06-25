// scripts/stamp-version.ts
export function stampVersion(pkgJson: string, version: string): string {
  const v = version.replace(/^v/, "");
  // Replace only the top-level "version" field; preserve everything else byte-for-byte.
  return pkgJson.replace(/("version":\s*")[^"]*(")/, `$1${v}$2`);
}

if (import.meta.main) {
  const [version, path = "package.json"] = process.argv.slice(2);
  if (!version) {
    process.stderr.write("usage: stamp-version.ts <version> [path]\n");
    process.exit(2);
  }
  const text = await Bun.file(path).text();
  await Bun.write(path, stampVersion(text, version));
  process.stdout.write(`stamped ${path} -> ${version.replace(/^v/, "")}\n`);
}
