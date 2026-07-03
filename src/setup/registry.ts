import { goDef } from "./lang/go.ts";
import { jvmGradleDef, jvmMavenDef } from "./lang/jvm.ts";
import { nodeDef } from "./lang/node.ts";
import { phpDef } from "./lang/php.ts";
import { pythonDef } from "./lang/python.ts";
import { rubyDef } from "./lang/ruby.ts";
import { rustDef } from "./lang/rust.ts";
import type { LangDef } from "./lang/types.ts";

export const REGISTRY: LangDef[] = [
  rustDef,
  nodeDef,
  pythonDef,
  goDef,
  jvmMavenDef,
  jvmGradleDef,
  rubyDef,
  phpDef,
];
