import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Component } from "../dispatch/profile.ts";
import { nodeManager } from "../setup/node-manager.ts";
import type { CmdRunner } from "../util/run-command.ts";
import type { TestEnvironmentPlan } from "./environment-schema.ts";

export type KarmaPlan = Extract<TestEnvironmentPlan, { adapter: "karma" }>;
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const browsers = new Set(["Firefox", "FirefoxHeadless", "Chrome", "ChromeHeadless"]);

/** Deliberately bounded grammar: do not reinterpret arbitrary wrappers or config flags. */
export function karmaPlan(
  repo: string,
  c: Component,
  policy: "managed" | "existing",
): TestEnvironmentPlan | undefined {
  const dir = join(repo, c.dir ?? ".");
  if (typeof c.commands.test !== "string" || !existsSync(join(dir, "package.json"))) return;
  const script =
    c.commands.test === "npm test" ? "test" : /^npm run ([\w:.-]+)$/.exec(c.commands.test)?.[1];
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const body = script ? pkg.scripts?.[script] : undefined;
  if (typeof body !== "string" || !/\bkarma\b/.test(body)) return;
  const base = {
    version: 1 as const,
    policy,
    suiteCommand: c.commands.test,
    workspaceDir: c.dir ?? ".",
  };
  const unsupported = (reason: string): TestEnvironmentPlan => ({
    ...base,
    adapter: "unsupported",
    reason,
  });
  const match =
    /^(?:\.\/node_modules\/\.bin\/)?karma start --browsers ([A-Za-z,]+) --single-run$/.exec(body);
  if (
    !match ||
    match[1].split(",").some((b) => !browsers.has(b)) ||
    new Set(match[1].split(",")).size !== match[1].split(",").length
  )
    return unsupported(
      "Karma suite adapter requires karma start --browsers <built-in browsers> --single-run with default karma.conf.js; custom wrappers/options require another qualified adapter.",
    );
  if (pkg.scripts?.[`pre${script}`] || pkg.scripts?.[`post${script}`])
    return unsupported(
      "Karma readiness cannot qualify npm pre/post lifecycle hooks without running their side effects; declare a dedicated suite script without hooks.",
    );
  const selection = nodeManager(repo, dir);
  if (selection.manager !== "npm")
    return unsupported("Karma command requires the declared npm manager");
  if (!existsSync(join(dir, "karma.conf.js")))
    return unsupported("Karma default config karma.conf.js is missing");
  return {
    ...base,
    adapter: "karma",
    manager: "npm",
    managerVersion: selection.version,
    workspaceDir: selection.workspaceDir,
    configFile: "karma.conf.js",
    browsers: match[1].split(",") as KarmaPlan["browsers"],
  };
}

// Public Karma 4 config/reporter API. This is also tested against Sphinx's installed 4.2.0.
export function karmaConfigLoader(cwd: string, plan: KarmaPlan): string {
  return `const path=require('path'),fs=require('fs');
const root=fs.realpathSync(${JSON.stringify(cwd)});
const resolve=(name)=>require.resolve(name,{paths:[root]});
const metadata=require(resolve('karma/package.json'));
if(!/^4\\./.test(metadata.version)) throw Error('Karma adapter currently qualifies version 4 only');
const original=path.join(root,${JSON.stringify(plan.configFile)});
const cli={configFile:original,browsers:${JSON.stringify(plan.browsers)},singleRun:true};`;
}

/** No collection claim: readiness checks installed providers/browser prerequisites only. */
export async function qualifyKarma(cwd: string, plan: KarmaPlan, run: CmdRunner) {
  const script = `${karmaConfigLoader(cwd, plan)}
module.exports=function(config){
config.configFile=original;
const returned=require(original)(config);
if(returned && typeof returned.then==='function') throw Error('Async Karma configuration requires another adapter');
config.set(cli);
if(config.customLaunchers && Object.keys(config.customLaunchers).length) throw Error('Custom Karma launchers require qualification');
// Version-scoped Karma adapter uses the same resolver as Karma's server, including its
// package-relative glob directory, ignored packages, explicit paths and load errors.
const providers={};
const modules=require(resolve('karma/lib/plugin')).resolve(config.plugins,{emit:function(){throw Error('Karma plugin resolution failed');}});
for(const plugin of modules) Object.assign(providers,plugin);
for(const name of config.frameworks) if(!providers['framework:'+name]) throw Error('Missing Karma framework provider: '+name);
const measured=[];
for(const name of cli.browsers){
 if(!providers['launcher:'+name]) throw Error('Missing Karma browser launcher: '+name);
 const launcher=providers['launcher:'+name][1];
 const prototype=launcher && launcher.prototype;
 const binary=prototype && (process.env[prototype.ENV_CMD] || (prototype.DEFAULT_CMD && prototype.DEFAULT_CMD[process.platform]));
 if(typeof binary!=='string' || !binary) throw Error('Browser launcher does not expose a qualified executable: '+name);
 const result=require('child_process').spawnSync(binary,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:16384});
 if(result.status!==0) throw Error('Browser executable unavailable: '+name);
 if(process.platform==='linux' && !name.endsWith('Headless') && !process.env.DISPLAY) throw Error('Declared headed browser requires a display: '+name);
 measured.push({name,binary,version:result.stdout.trim().slice(0,200),displayPresent:!!process.env.DISPLAY});
}
fs.writeSync(1,'STYRE_KARMA_READY='+JSON.stringify({version:metadata.version,node:{executable:process.execPath,version:process.versions.node},frameworks:config.frameworks,browsers:measured,configFile:original,collection:'unsupported'})+'\\n');
process.exit(0);
};`;
  const manager = await run("COREPACK_ENABLE_NETWORK=0 npm --version", { cwd, timeoutMs: 15000 });
  if (
    manager.exitCode !== 0 ||
    manager.timedOut ||
    (plan.managerVersion && manager.stdout.trim() !== plan.managerVersion)
  )
    return { ready: false, reason: "Declared npm version is unavailable or differs", evidence: {} };
  const dir = mkdtempSync(join(tmpdir(), "styre-karma-probe-"));
  let out: Awaited<ReturnType<CmdRunner>>;
  try {
    const file = join(dir, "probe.cjs");
    writeFileSync(file, script, { mode: 0o600 });
    // Karma 4 treats a bare --single-run followed by a path as a string value, and
    // strips arguments after --. Reassert the SAME true setting with an explicit value
    // so the appended wrapper remains positional. Never change the selected browser.
    out = await run(`${plan.suiteCommand} -- --single-run=true ${quote(file)}`, {
      cwd,
      timeoutMs: 45000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const lines = out.stdout.split("\n").filter((s) => s.startsWith("STYRE_KARMA_READY="));
  if (out.exitCode !== 0 || out.timedOut || lines.length !== 1)
    return {
      ready: false,
      reason:
        "Karma config, framework plugins, browser executable or display could not be qualified; inspect bounded readiness probes",
      evidence: { collection: "unsupported" },
    };
  try {
    const evidence = z
      .object({
        version: z.string().regex(/^4\./),
        node: z.object({ executable: z.string().min(1), version: z.string().min(1) }),
        frameworks: z.array(z.string()),
        browsers: z
          .array(
            z.object({
              name: z.string(),
              binary: z.string(),
              version: z.string(),
              displayPresent: z.boolean(),
            }),
          )
          .length(plan.browsers.length),
        configFile: z.literal(realpathSync(join(cwd, plan.configFile))),
        collection: z.literal("unsupported"),
      })
      .parse(JSON.parse(lines[0].slice("STYRE_KARMA_READY=".length)));
    if (evidence.browsers.some((b, i) => b.name !== plan.browsers[i]))
      throw Error("Browser observation differs from intent");
    return { ready: true, evidence: { ...evidence, npmVersion: manager.stdout.trim() } };
  } catch {
    return { ready: false, reason: "Malformed Karma readiness receipt", evidence: {} };
  }
}

const count = z.number().int().nonnegative();
export const KarmaCompletionSchema = z
  .object({
    version: z.literal(1),
    browsers: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string(),
            success: count,
            failed: count,
            skipped: count,
            total: count,
            error: z.boolean(),
            completed: z.boolean(),
            runtimeErrors: count,
            disconnected: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    success: count,
    failed: count,
    exitCode: z.number().int(),
    error: z.boolean(),
    disconnected: z.boolean(),
  })
  .strict();
export type KarmaCompletion = z.infer<typeof KarmaCompletionSchema>;

export function karmaVerdict(
  report: unknown,
  exitCode: number | null,
  expectedBrowsers: number,
): "pass" | "fail" | "error" {
  const parsed = KarmaCompletionSchema.safeParse(report);
  if (!parsed.success || exitCode === null) return "error";
  const r = parsed.data;
  if (
    r.browsers.length !== expectedBrowsers ||
    new Set(r.browsers.map((b) => b.id)).size !== expectedBrowsers ||
    r.error !== r.browsers.some((b) => b.error) ||
    r.disconnected ||
    r.exitCode !== exitCode ||
    r.browsers.some(
      (b) =>
        !b.completed ||
        b.runtimeErrors > 0 ||
        // Karma 4 Browser.onComplete sets error whenever success===0, even when every
        // selected spec completed with an ordinary assertion failure. Preserve that raw
        // flag, but distinguish it from observed browser_error events.
        (b.error && !(b.success === 0 && b.failed > 0)) ||
        b.disconnected ||
        b.success + b.failed === 0 ||
        b.total !== b.success + b.failed + b.skipped,
    ) ||
    r.success !== r.browsers.reduce((sum, b) => sum + b.success, 0) ||
    r.failed !== r.browsers.reduce((sum, b) => sum + b.failed, 0)
  )
    return "error";
  if (r.failed > 0) return exitCode === 1 ? "fail" : "error";
  return exitCode === 0 ? "pass" : "error";
}

/** Wrap only configuration and add a reporter. Original CLI, npm lifecycle, suite files and browsers remain authoritative. */
export function karmaReporterConfig(cwd: string, plan: KarmaPlan, reportPath: string): string {
  return `${karmaConfigLoader(cwd, plan)}
module.exports=function(config){
 const wrapper=config.configFile;
 config.configFile=original;
 const returned=require(original)(config);
if(returned && typeof returned.then==='function') throw Error('Async Karma configuration requires another adapter');
 if(config.customLaunchers && Object.keys(config.customLaunchers).length) throw Error('Custom Karma launchers require qualification');
 config.configFile=wrapper;
 config.basePath=path.resolve(path.dirname(original),config.basePath||'');
 config.exclude=(config.exclude||[]).concat(original);
 function StyreReporter(){
  const completed=new Set(), runtimeErrors=new Map();
  this.onBrowserComplete=function(browser){completed.add(String(browser.id));};
  this.onBrowserError=function(browser){const id=String(browser.id);runtimeErrors.set(id,(runtimeErrors.get(id)||0)+1);};
  this.onRunComplete=function(browsers,result){
   const rows=browsers.map(function(browser){const r=browser.lastResult;return {id:String(browser.id),name:browser.name,success:r.success,failed:r.failed,skipped:r.skipped,total:r.total,error:!!r.error,completed:completed.has(String(browser.id)),runtimeErrors:runtimeErrors.get(String(browser.id))||0,disconnected:!!r.disconnected};});
   const record={version:1,browsers:rows,success:result.success,failed:result.failed,exitCode:result.exitCode,error:!!result.error,disconnected:!!result.disconnected};
   const text=JSON.stringify(record); if(text.length>65536) throw Error('Karma completion exceeds evidence bound');
   fs.writeFileSync(${JSON.stringify(`${reportPath}.tmp`)},text,{mode:384,flag:'wx'});
   fs.renameSync(${JSON.stringify(`${reportPath}.tmp`)},${JSON.stringify(reportPath)});
  };
 }
 StyreReporter.$inject=[];
 config.plugins=config.plugins.concat({'reporter:styre-completion':['type',StyreReporter]});
 const reporters=typeof config.reporters==='string'?config.reporters.split(','):config.reporters;
 config.reporters=reporters.concat('styre-completion');
};`;
}
