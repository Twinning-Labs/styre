/** Narrow an unknown to a plain object (not array). Used to walk parsed TOML/JSON safely. */
export function rec(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** Leading distribution name from a PEP 508 requirement string, lowercased; null if none. */
function pep508Name(spec: string): string | null {
  const m = spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
  return m ? m[0].toLowerCase() : null;
}

function tomlDepKeys(table: unknown): string[] {
  const t = rec(table);
  return t ? Object.keys(t) : [];
}

export function parseCargoToml(content: string): string[] {
  try {
    const t = Bun.TOML.parse(content) as unknown;
    const root = rec(t);
    if (!root) return [];
    const names = new Set<string>();
    for (const k of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const name of tomlDepKeys(root[k])) names.add(name);
    }
    const target = rec(root.target);
    if (target) {
      for (const cfg of Object.values(target)) {
        const c = rec(cfg);
        if (!c) continue;
        for (const k of ["dependencies", "dev-dependencies", "build-dependencies"]) {
          for (const name of tomlDepKeys(c[k])) names.add(name);
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

export function parsePyproject(content: string): string[] {
  try {
    const t = Bun.TOML.parse(content) as unknown;
    const root = rec(t);
    if (!root) return [];
    const names = new Set<string>();

    const project = rec(root.project);
    const projDeps = project?.dependencies;
    if (Array.isArray(projDeps)) {
      for (const s of projDeps) {
        if (typeof s === "string") {
          const n = pep508Name(s);
          if (n) names.add(n);
        }
      }
    }
    const optional = rec(project?.["optional-dependencies"]);
    if (optional) {
      for (const arr of Object.values(optional)) {
        if (Array.isArray(arr)) {
          for (const s of arr) {
            if (typeof s === "string") {
              const n = pep508Name(s);
              if (n) names.add(n);
            }
          }
        }
      }
    }

    const poetry = rec(rec(root.tool)?.poetry);
    for (const name of tomlDepKeys(poetry?.dependencies)) {
      if (name !== "python") names.add(name.toLowerCase());
    }
    const groups = rec(poetry?.group);
    if (groups) {
      for (const g of Object.values(groups)) {
        for (const name of tomlDepKeys(rec(g)?.dependencies)) {
          if (name !== "python") names.add(name.toLowerCase());
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}
