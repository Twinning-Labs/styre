import pkg from "../package.json";

/** Single source of truth for the binary version (from package.json). */
export const VERSION: string = pkg.version;
