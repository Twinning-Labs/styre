import { nodeDef } from "./lang/node.ts";
import { rustDef } from "./lang/rust.ts";
import type { LangDef } from "./lang/types.ts";

export const REGISTRY: LangDef[] = [rustDef, nodeDef];
