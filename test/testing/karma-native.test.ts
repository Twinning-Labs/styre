import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { observeSuiteCommand, suiteResult } from "../../src/dispatch/suite-observation.ts";
import { planTestEnvironment, qualifyTestEnvironment } from "../../src/testing/environment.ts";
import { karmaReporterConfig } from "../../src/testing/karma.ts";
const deps = process.env.STYRE_KARMA_NATIVE_DEPS;
test.skipIf(!deps)(
  "native Karma 4/Firefox: original context, passing/failing/empty/config-error/timeout",
  async () => {
    if (!deps) throw Error("missing native dependencies");
    const root = mkdtempSync(join(tmpdir(), "styre-karma-native-"));
    try {
      symlinkSync(deps, join(root, "node_modules"), "dir");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "karma start --browsers Firefox --single-run" } }),
      );
      mkdirSync(join(root, "spec"));
      const config = `module.exports=c=>{
   if(process.env.npm_lifecycle_event!=='test') throw Error('npm lifecycle lost');
   if(c.configFile!==__filename||c.singleRun!==true||c.browsers[0]!=='Firefox') throw Error('original CLI context lost');
   c.set({basePath:'.',frameworks:['jasmine'],files:['spec/*.js'],reporters:['dots'],browsers:['Chrome'],singleRun:false,port:9876,captureTimeout:5000,browserNoActivityTimeout:2000});
  };`;
      writeFileSync(join(root, "karma.conf.js"), config);
      const c = parseProfile({
        slug: "native",
        targetRepo: root,
        components: [
          { name: "browser", kind: "node", paths: ["**"], commands: { test: "npm test" } },
        ],
      }).components[0];
      c.testEnvironment = planTestEnvironment(root, c, "existing");
      expect(c.testEnvironment?.adapter).toBe("karma");
      const ready = await qualifyTestEnvironment(root, c, { collect: true });
      expect({
        status: ready.status,
        reason: ready.reason,
        probes: ready.status === "ready" ? undefined : ready.probes,
      }).toMatchObject({ status: "ready" });
      expect(ready.collection).toBeUndefined();
      const run = () =>
        observeSuiteCommand({
          sha: "fixture-sha",
          command: "npm test",
          cwd: root,
          environment: c.testEnvironment,
          timeoutMs: 20000,
        });
      writeFileSync(
        join(root, "spec/example.js"),
        "describe('example',()=>{it('truth',()=>expect(1).toBe(1));});",
      );
      const pass = await run();
      expect({
        verdict: suiteResult(pass),
        stdout: pass.stdout,
        stderr: pass.stderr,
        karma: pass.karma,
      }).toMatchObject({ verdict: "pass", karma: { completion: { success: 1, failed: 0 } } });
      expect(pass.command).toBe("npm test");
      const priorFirefox = process.env.FIREFOX_BIN;
      try {
        process.env.FIREFOX_BIN = join(root, "missing-firefox");
        expect((await qualifyTestEnvironment(root, c)).status).toBe("requires-preparation");
        expect(suiteResult(await run())).toBe("error");
      } finally {
        if (priorFirefox === undefined) delete process.env.FIREFOX_BIN;
        else process.env.FIREFOX_BIN = priorFirefox;
      }
      expect(readFileSync(join(root, "karma.conf.js"), "utf8")).toBe(config);
      writeFileSync(
        join(root, "spec/example.js"),
        "describe('example',()=>{it('false',()=>expect(1).toBe(2));});",
      );
      expect(suiteResult(await run())).toBe("fail");
      writeFileSync(join(root, "spec/example.js"), "");
      expect(suiteResult(await run())).toBe("error");
      writeFileSync(
        join(root, "spec/example.js"),
        "describe('example',()=>{it('hangs',()=>{while(true){}});});",
      );
      const timeout = await observeSuiteCommand({
        sha: "fixture-sha",
        command: "npm test",
        cwd: root,
        environment: c.testEnvironment,
        timeoutMs: 1000,
      });
      expect(timeout.timedOut).toBe(true);
      expect(suiteResult(timeout)).toBe("error");
      writeFileSync(join(root, "karma.conf.js"), "throw Error('broken config');");
      expect(suiteResult(await run())).toBe("error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);

test.skipIf(!process.env.STYRE_KARMA_SPHINX)(
  "native Sphinx baseline suite through original npm wrapper",
  async () => {
    const root = process.env.STYRE_KARMA_SPHINX;
    if (!root) throw Error("missing Sphinx fixture");
    const c = parseProfile({
      slug: "sphinx",
      targetRepo: root,
      components: [
        { name: "frontend", kind: "node", paths: ["**"], commands: { test: "npm test" } },
      ],
    }).components[0];
    c.testEnvironment = planTestEnvironment(root, c, "existing");
    const ready = await qualifyTestEnvironment(root, c, { collect: true });
    expect({
      status: ready.status,
      probes: ready.status === "ready" ? undefined : ready.probes,
    }).toMatchObject({ status: "ready" });
    const run = await observeSuiteCommand({
      sha: "2e506c5ab457cba743bb47eb5b8c8eb9dd51d23d",
      command: "npm test",
      cwd: root,
      environment: c.testEnvironment,
      timeoutMs: 45000,
    });
    expect({
      verdict: suiteResult(run),
      stdout: run.stdout,
      stderr: run.stderr,
      karma: run.karma,
    }).toMatchObject({ verdict: "pass" });
    console.log(
      JSON.stringify({
        fixture: "Sphinx original baseline browser suite",
        karma: run.karma,
        timing: run.timing,
      }),
    );
  },
  60000,
);

test.skipIf(!deps)(
  "native Karma config/reporter protocol preserves original paths and writes completion",
  () => {
    if (!deps) throw Error("missing native dependencies");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "styre-karma-config-")));
    try {
      symlinkSync(deps, join(root, "node_modules"), "dir");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { test: "karma start --browsers Firefox --single-run" } }),
      );
      writeFileSync(
        join(root, "karma.conf.js"),
        `module.exports=c=>{if(c.configFile!==__filename)throw Error('path context');c.set({basePath:'spec',files:['*.js'],reporters:['dots'],plugins:['karma-*'],frameworks:['jasmine']});};`,
      );
      const c = parseProfile({
        slug: "native",
        targetRepo: root,
        components: [
          { name: "browser", kind: "node", paths: ["**"], commands: { test: "npm test" } },
        ],
      }).components[0];
      const plan = planTestEnvironment(root, c, "existing");
      if (plan?.adapter !== "karma") throw Error("missing Karma plan");
      const report = join(root, "receipt.json");
      const wrapper = join(root, "wrapper.cjs");
      writeFileSync(wrapper, karmaReporterConfig(root, plan, report));
      const require = createRequire(join(root, "package.json"));
      const karma = require("karma");
      const config = karma.config.parseConfig(wrapper, {
        configFile: wrapper,
        browsers: ["Firefox"],
        singleRun: true,
      });
      expect(config.basePath).toBe(join(root, "spec"));
      expect(config.files[0].pattern).toBe(join(root, "spec", "*.js"));
      expect(config.exclude).toContain(join(root, "karma.conf.js"));
      expect(config.reporters).toEqual(["dots", "styre-completion"]);
      expect(config.browsers).toEqual(["Firefox"]);
      const Reporter = config.plugins.at(-1)["reporter:styre-completion"][1];
      const reporter = new Reporter();
      reporter.onRunComplete(
        [
          {
            id: "browser",
            name: "Firefox",
            lastResult: {
              success: 1,
              failed: 0,
              skipped: 0,
              total: 1,
              error: false,
              disconnected: false,
            },
          },
        ],
        { success: 1, failed: 0, exitCode: 0, error: false, disconnected: false },
      );
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
        version: 1,
        success: 1,
        failed: 0,
        browsers: [{ id: "browser", total: 1 }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
