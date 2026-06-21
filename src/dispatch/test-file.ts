/** Classify a path as a test file. With an explicit `pattern` (a regex source string from the
 *  project profile) that regex decides; otherwise a built-in heuristic covering common stacks.
 *  Used by the behavioral gate (A1) — "did the coding diff add/modify a test?". */
const DEFAULT_TEST_FILE =
  /(?:^|\/)(?:tests?|specs?|__tests__)\/|(?:\.(?:test|spec)\.[jt]sx?$)|(?:_test\.[a-z0-9]+$)|(?:(?:^|\/)test_[^/]+$)/i;

export function isTestFile(path: string, pattern?: string): boolean {
  if (pattern !== undefined && pattern !== "") {
    return new RegExp(pattern).test(path);
  }
  return DEFAULT_TEST_FILE.test(path);
}
