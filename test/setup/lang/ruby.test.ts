import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rubyDef, rubyTestCommand } from "../../../src/setup/lang/ruby.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ruby-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("ruby: no Gemfile → []", () => {
  const root = fixture({ "README.md": "x" });
  expect(rubyDef.detect(root)).toHaveLength(0);
});

test("ruby: Gemfile + .rspec → bundle exec rspec; every field correct", () => {
  const root = fixture({
    Gemfile: "source 'https://rubygems.org'\ngem 'rspec'\n",
    ".rspec": "--format documentation\n",
  });
  const components = rubyDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("ruby");
  expect(c.kind).toBe("ruby");
  expect(c.paths).toEqual(["**"]);
  expect(c.commands.test).toBe("bundle exec rspec");
  // prepare is on the object at runtime even before the type carries it
  expect((c as Record<string, unknown>).prepare).toBe("bundle install");
  expect(c.testFilePattern).toBe("_(test|spec)\\.rb$");
});

test("ruby: Gemfile + spec/ dir → bundle exec rspec", () => {
  const root = fixture({ Gemfile: "", "spec/spec_helper.rb": "" });
  const components = rubyDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.commands.test).toBe("bundle exec rspec");
  expect((c as Record<string, unknown>).prepare).toBe("bundle install");
  expect(c.testFilePattern).toBe("_(test|spec)\\.rb$");
  expect(c.kind).toBe("ruby");
  expect(c.paths).toEqual(["**"]);
});

test("ruby: Gemfile + Rakefile (no .rspec, no spec/) → bundle exec rake test", () => {
  const root = fixture({ Gemfile: "", Rakefile: "task :test do\nend\n" });
  const components = rubyDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.commands.test).toBe("bundle exec rake test");
  expect((c as Record<string, unknown>).prepare).toBe("bundle install");
  expect(c.testFilePattern).toBe("_(test|spec)\\.rb$");
  expect(c.kind).toBe("ruby");
  expect(c.paths).toEqual(["**"]);
});

test("ruby: Gemfile only (no .rspec, no spec/, no Rakefile) → test: { unavailable: true }", () => {
  const root = fixture({ Gemfile: "" });
  const components = rubyDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.commands.test).toEqual({ unavailable: true });
  expect((c as Record<string, unknown>).prepare).toBe("bundle install");
  expect(c.testFilePattern).toBe("_(test|spec)\\.rb$");
  expect(c.kind).toBe("ruby");
  expect(c.paths).toEqual(["**"]);
});

test("ruby: .rspec takes precedence over Rakefile when both present", () => {
  const root = fixture({
    Gemfile: "",
    ".rspec": "--format documentation\n",
    Rakefile: "task :test do\nend\n",
  });
  const [c] = rubyDef.detect(root);
  expect(c.commands.test).toBe("bundle exec rspec");
});

test("rubyTestCommand: spec/ dir alone (no .rspec) → bundle exec rspec", () => {
  const root = fixture({ "spec/support/helpers.rb": "" });
  expect(rubyTestCommand(root).test).toBe("bundle exec rspec");
});

test("rubyTestCommand: no signals → { unavailable: true }", () => {
  const root = fixture({});
  expect(rubyTestCommand(root).test).toEqual({ unavailable: true });
});
