export type RenderResult = { ok: true; prompt: string } | { ok: false; missing: string[] };

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Distinct `{{name}}` placeholder names in first-seen order. */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Render a prompt template, substituting `{{name}}` from `vars`. Any placeholder with no
 *  value is the CL-PROFILE failure — returned as `missing` (M3b escalates a setup error). */
export function renderPrompt(template: string, vars: Record<string, string>): RenderResult {
  const missing = placeholders(template).filter((name) => !(name in vars));
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const prompt = template.replace(PLACEHOLDER, (_match, name: string) => vars[name] ?? "");
  return { ok: true, prompt };
}
