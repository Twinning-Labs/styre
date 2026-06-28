import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jvmGradleDef, jvmMavenDef } from "../../../src/setup/lang/jvm.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-jvm-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

// --- Maven ---

test("jvm-maven: root pom.xml → jvm-maven (bare mvn when no wrapper)", () => {
  const root = fixture({ "pom.xml": "<project/>" });
  const components = jvmMavenDef.detect(root);
  expect(components).toHaveLength(1);
  const [m] = components;
  expect(m.name).toBe("jvm-maven");
  expect(m.kind).toBe("jvm-maven");
  expect(m.paths).toEqual(["**"]);
  expect(m.commands.build).toBe("mvn -q -DskipTests compile");
  expect(m.commands.test).toBe("mvn -q test");
});

test("jvm-maven: pom.xml + mvnw → prefers the maven wrapper", () => {
  const root = fixture({ "pom.xml": "<project/>", mvnw: "#!/bin/sh\n" });
  const components = jvmMavenDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].commands.build).toBe("./mvnw -q -DskipTests compile");
  expect(components[0].commands.test).toBe("./mvnw -q test");
});

test("jvm-maven: no pom.xml → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(jvmMavenDef.detect(root)).toHaveLength(0);
});

test("jvm-maven: nested-only pom.xml → no component (root-only detection)", () => {
  const root = fixture({ "module/pom.xml": "<project/>" });
  expect(jvmMavenDef.detect(root)).toHaveLength(0);
});

// --- Gradle ---

test("jvm-gradle: build.gradle → jvm-gradle (bare gradle when no wrapper)", () => {
  const root = fixture({ "build.gradle": "" });
  const components = jvmGradleDef.detect(root);
  expect(components).toHaveLength(1);
  const [g] = components;
  expect(g.name).toBe("jvm-gradle");
  expect(g.kind).toBe("jvm-gradle");
  expect(g.paths).toEqual(["**"]);
  expect(g.commands.build).toBe("gradle build -x test");
  expect(g.commands.test).toBe("gradle test");
});

test("jvm-gradle: build.gradle.kts → jvm-gradle (bare gradle when no wrapper)", () => {
  const root = fixture({ "build.gradle.kts": "" });
  const components = jvmGradleDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].kind).toBe("jvm-gradle");
  expect(components[0].commands.build).toBe("gradle build -x test");
  expect(components[0].commands.test).toBe("gradle test");
});

test("jvm-gradle: build.gradle + gradlew → prefers the gradle wrapper", () => {
  const root = fixture({ "build.gradle": "", gradlew: "#!/bin/sh\n" });
  const components = jvmGradleDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].commands.build).toBe("./gradlew build -x test");
  expect(components[0].commands.test).toBe("./gradlew test");
});

test("jvm-gradle: build.gradle.kts + gradlew → prefers the gradle wrapper", () => {
  const root = fixture({ "build.gradle.kts": "", gradlew: "#!/bin/sh\n" });
  const components = jvmGradleDef.detect(root);
  expect(components).toHaveLength(1);
  expect(components[0].commands.build).toBe("./gradlew build -x test");
  expect(components[0].commands.test).toBe("./gradlew test");
});

test("jvm-gradle: no gradle manifest → no components", () => {
  const root = fixture({ "README.md": "x" });
  expect(jvmGradleDef.detect(root)).toHaveLength(0);
});

test("jvm-gradle: nested-only build.gradle → no component (root-only detection)", () => {
  const root = fixture({ "module/build.gradle": "" });
  expect(jvmGradleDef.detect(root)).toHaveLength(0);
});
