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

export function parseRequirementsTxt(content: string): string[] {
  const names = new Set<string>();
  // A VCS/URL install is only nameable via its #egg=<name> fragment; otherwise skip it
  // (never emit the URL scheme like "git" as a dependency name).
  const addEgg = (line: string): void => {
    const egg = line.match(/[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (egg?.[1]) names.add(egg[1].toLowerCase());
  };
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    // Options/includes (-r/-c/--hash) and editable installs (-e): only -e VCS with #egg names anything.
    if (line.startsWith("-")) {
      addEgg(line);
      continue;
    }
    if (/^(https?:|git\+|hg\+|svn\+|bzr\+|file:)/.test(line)) {
      addEgg(line);
      continue;
    }
    const head = (line.split("@")[0] ?? line).trim();
    const m = head.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    if (m) names.add(m[0].toLowerCase());
  }
  return [...names];
}

export function parseGoMod(content: string): string[] {
  const names = new Set<string>();
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      const path = line.split(/\s+/)[0];
      if (path) names.add(path);
    } else if (line.startsWith("require (")) {
      inBlock = true;
    } else if (line.startsWith("require ")) {
      const path = line.slice("require ".length).trim().split(/\s+/)[0];
      if (path) names.add(path);
    }
  }
  return [...names];
}

export function parseGemfile(content: string): string[] {
  const names = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^gem\s+['"]([^'"]+)['"]/);
    if (m?.[1]) names.add(m[1].toLowerCase());
  }
  return [...names];
}

function jsonDepKeys(content: string, keys: string[]): string[] {
  try {
    const obj = rec(JSON.parse(content));
    if (!obj) return [];
    const names: string[] = [];
    for (const k of keys) {
      const table = rec(obj[k]);
      if (table) names.push(...Object.keys(table));
    }
    return names;
  } catch {
    return [];
  }
}

export function parsePackageJson(content: string): string[] {
  return jsonDepKeys(content, ["dependencies", "devDependencies"]).map((n) => n.toLowerCase());
}

export function parseComposerJson(content: string): string[] {
  return jsonDepKeys(content, ["require", "require-dev"])
    .filter((n) => n !== "php" && !n.startsWith("ext-"))
    .map((n) => n.toLowerCase());
}
