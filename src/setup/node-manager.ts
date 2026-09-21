import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type NodeManager = "npm" | "pnpm" | "yarn" | "bun";
export interface NodeManagerSelection {
  manager?: NodeManager;
  version?: string;
  workspaceDir: string;
  reason?: string;
}
function workspaceContains(dir: string, component: string, pkg: Record<string, unknown>): boolean {
  let patterns: unknown = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : (pkg.workspaces as { packages?: unknown } | undefined)?.packages;
  const pnpm = join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpm))
    patterns = (Bun.YAML.parse(readFileSync(pnpm, "utf8")) as { packages?: unknown })?.packages;
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) return false;
  const rel = relative(dir, component);
  return (
    patterns.some((p) => !p.startsWith("!") && new Bun.Glob(p.replace(/\/$/, "")).match(rel)) &&
    !patterns.some(
      (p) => p.startsWith("!") && new Bun.Glob(p.slice(1).replace(/\/$/, "")).match(rel),
    )
  );
}
/** Inherit only from a declared workspace that includes this package, never an incidental ancestor lockfile. */
export function nodeManager(repoDir: string, componentDir = repoDir): NodeManagerSelection {
  const root = resolve(repoDir);
  const component = resolve(componentDir);
  if (component !== root && !component.startsWith(`${root}/`))
    return { workspaceDir: ".", reason: "Component is outside repository" };
  let dir = component;
  let declared: { manager: NodeManager; version?: string } | undefined;
  let owner = component;
  while (true) {
    const pkgPath = join(dir, "package.json");
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
    const belongs = dir === component || workspaceContains(dir, component, pkg);
    if (belongs) {
      owner = dir;
      if (pkg.packageManager !== undefined) {
        const m =
          typeof pkg.packageManager === "string" &&
          /^(npm|pnpm|yarn|bun)@([^\s]+)$/.exec(pkg.packageManager);
        if (!m)
          return {
            workspaceDir: relative(root, owner) || ".",
            reason: "Unsupported packageManager declaration",
          };
        const next = { manager: m[1] as NodeManager, version: m[2].split("+")[0] };
        if (declared && (declared.manager !== next.manager || declared.version !== next.version))
          return {
            workspaceDir: relative(root, owner) || ".",
            reason: "Conflicting workspace packageManager declarations",
          };
        declared = next;
      }
      const locks = (
        [
          ["npm", "package-lock.json"],
          ["pnpm", "pnpm-lock.yaml"],
          ["yarn", "yarn.lock"],
          ["bun", "bun.lock"],
          ["bun", "bun.lockb"],
        ] as const
      )
        .filter(([, file]) => existsSync(join(dir, file)))
        .map(([manager]) => manager);
      const distinct = [...new Set(locks)];
      if (
        distinct.length > 1 ||
        (declared && distinct.length && !distinct.includes(declared.manager))
      )
        return {
          workspaceDir: relative(root, owner) || ".",
          reason: "Conflicting package-manager declaration/lockfiles",
        };
      if (distinct.length)
        return {
          ...declared,
          manager: declared?.manager ?? distinct[0],
          workspaceDir: relative(root, owner) || ".",
        };
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return {
    manager: declared?.manager ?? "npm",
    version: declared?.version,
    workspaceDir: relative(root, owner) || ".",
  };
}
export function nodeInstall(selection: NodeManagerSelection): string | undefined {
  switch (selection.manager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return selection.version && Number.parseInt(selection.version) >= 2
        ? "yarn install --immutable"
        : "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
    case "npm":
      return "npm install";
    default:
      return undefined;
  }
}
