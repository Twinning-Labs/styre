import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../../src/config/paths.ts";

test("configDir honors XDG_CONFIG_HOME", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/xdgcfg";
  try {
    expect(configDir()).toBe("/tmp/xdgcfg/styre");
  } finally {
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("configDir falls back to ~/.config when XDG_CONFIG_HOME is unset/empty", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "";
  try {
    expect(configDir()).toBe(join(homedir(), ".config", "styre"));
  } finally {
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});
