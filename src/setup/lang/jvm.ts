import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ComponentDraft, LangDef } from "./types.ts";

export const jvmMavenDef: LangDef = {
  kind: "jvm-maven",
  detect(repoDir: string): ComponentDraft[] {
    if (!existsSync(join(repoDir, "pom.xml"))) return [];
    const mvn = existsSync(join(repoDir, "mvnw")) ? "./mvnw" : "mvn";
    return [
      {
        name: "jvm-maven",
        kind: "jvm-maven",
        paths: ["**"],
        commands: { build: `${mvn} -q -DskipTests compile`, test: `${mvn} -q test` },
      },
    ];
  },
};

export const jvmGradleDef: LangDef = {
  kind: "jvm-gradle",
  detect(repoDir: string): ComponentDraft[] {
    if (
      !existsSync(join(repoDir, "build.gradle")) &&
      !existsSync(join(repoDir, "build.gradle.kts"))
    )
      return [];
    const gradle = existsSync(join(repoDir, "gradlew")) ? "./gradlew" : "gradle";
    return [
      {
        name: "jvm-gradle",
        kind: "jvm-gradle",
        paths: ["**"],
        commands: { build: `${gradle} build -x test`, test: `${gradle} test` },
      },
    ];
  },
};
