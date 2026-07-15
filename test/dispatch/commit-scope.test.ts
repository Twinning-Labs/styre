import { expect, test } from "bun:test";
import {
  checksScopeFor,
  docScope,
  implementScope,
  planScope,
} from "../../src/dispatch/commit-scope.ts";

const sidecar = (obj: unknown) => `prose\n\`\`\`styre-sidecar\n${JSON.stringify(obj)}\n\`\`\`\n`;

test("implementScope: tracked edit always allowed; declared new file allowed; undeclared new rejected", () => {
  const inScope = implementScope(sidecar({ new_files: ["pkg/new.py"] }));
  expect(inScope("pkg/existing.py", false)).toBe(true); // tracked edit
  expect(inScope("pkg/new.py", true)).toBe(true); // declared new
  expect(inScope("./pkg/new.py", true)).toBe(true); // normalized
  expect(inScope("test_bug.py", true)).toBe(false); // undeclared scratch
});

test("implementScope: absent sidecar → any new file is out of scope (rejected, not dropped)", () => {
  const inScope = implementScope("no sidecar here");
  expect(inScope("pkg/existing.py", false)).toBe(true);
  expect(inScope("pkg/new.py", true)).toBe(false);
});

test("checksScopeFor: authored test_file allowed; extra new_files helper allowed; undeclared rejected", () => {
  const inScope = checksScopeFor("ENG-1", [1])(
    sidecar({
      checksAuthored: [{ ac_id: 1, test_file: "tests/test_x.py", test_name: "test_x" }],
      new_files: ["tests/conftest.py"],
    }),
  );
  expect(inScope("tests/test_x.py", true)).toBe(true);
  expect(inScope("tests/conftest.py", true)).toBe(true);
  expect(inScope("scratch.py", true)).toBe(false);
});

test("checksScopeFor: a canonically-named test at an UNDECLARED dir is in scope (divergence)", () => {
  const inScope = checksScopeFor("ENG-294", [1])(
    sidecar({
      // agent DECLARED a flat path but WROTE under styre_checks/ — the written file is undeclared
      checksAuthored: [
        { ac_id: 1, test_file: "tests/ENG-294_ac1_test.py", test_name: "test_bug" },
      ],
    }),
  );
  expect(inScope("tests/styre_checks/ENG-294_ac1_test.py", true)).toBe(true); // canonical name → admitted
  expect(inScope("tests/reproduce_bug.py", true)).toBe(false); // scratch → still rejected
});

test("checksScopeFor: unparseable sidecar → DEFERS (allows everything) so the handler decides", () => {
  const inScope = checksScopeFor("ENG-1", [1])("no sidecar");
  expect(inScope("anything.py", true)).toBe(true);
  expect(inScope("tests/test_x.py", true)).toBe(true);
});

test("planScope / docScope: only their doc trees, edit or new", () => {
  const plan = planScope("");
  expect(plan("docs/plans/ENG-1.md", true)).toBe(true);
  expect(plan("src/x.ts", false)).toBe(false); // stray tracked code edit rejected
  const doc = docScope("");
  expect(doc("docs/guide.md", true)).toBe(true);
  expect(doc("src/x.ts", false)).toBe(false);
});
