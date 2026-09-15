import { describe, expect, test } from "bun:test";
import { isWorkingTreeClean, main, parseOptions, type UpdateSourceDeps } from "../../scripts/update-source";

describe("update:source option parsing", () => {
  test("empty argv is valid and restarts by default", () => {
    const parsed = parseOptions([]);
    expect(parsed).toEqual({ ok: true, options: { noRestart: false } });
  });

  test("--proxy consumes the next argument as a one-shot git proxy", () => {
    const parsed = parseOptions(["--proxy", "http://127.0.0.1:7897"]);
    expect(parsed).toEqual({ ok: true, options: { proxy: "http://127.0.0.1:7897", noRestart: false } });
  });

  test("missing --proxy value and unknown flags are usage errors", () => {
    expect(parseOptions(["--proxy"])).toEqual({
      ok: false,
      message: "--proxy requires a URL, e.g. --proxy http://127.0.0.1:7897",
    });
    expect(parseOptions(["--turbo"]).ok).toBe(false);
  });

  test("--no-restart skips the stop/start tail", () => {
    const parsed = parseOptions(["--no-restart"]);
    expect(parsed).toEqual({ ok: true, options: { noRestart: true } });
  });
});

describe("update:source working-tree guard", () => {
  test("clean means zero porcelain output; any file or branch noise is dirty", () => {
    expect(isWorkingTreeClean("")).toBe(true);
    expect(isWorkingTreeClean("\n  \n")).toBe(true);
    expect(isWorkingTreeClean(" M src/cli/index.ts")).toBe(false);
    expect(isWorkingTreeClean("## main...origin/main [ahead 1]")).toBe(false);
  });
});

describe("update:source ordering (#stop-first)", () => {
  /**
   * The invariant update-stop-first.test.ts pins for `ocx update`: files are never
   * replaced under a live proxy. The source lane must hold it too, and the fake
   * probes keep the test off the real listener that may be running on this machine.
   */
  async function runRecordedMain(argv: readonly string[]): Promise<{ code: number; calls: string[] }> {
    const calls: string[] = [];
    const deps: UpdateSourceDeps = {
      spawn: (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 0, stdout: "" };
      },
      identityAt: async () => null,
      liveness: () => "dead",
    };
    const code = await main(argv, deps);
    return { code, calls };
  }

  test("stop runs before pull/install/build, and start is the last call", async () => {
    const { code, calls } = await runRecordedMain([]);
    expect(code).toBe(0);
    const stop = calls.findIndex(c => c.includes("index.ts stop"));
    const pull = calls.findIndex(c => c.includes("pull --ff-only"));
    const install = calls.findIndex(c => c.includes("install --frozen-lockfile"));
    const build = calls.findIndex(c => c.includes("run build:gui"));
    const start = calls.findIndex(c => c.includes("index.ts start"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(stop);
    expect(install).toBeGreaterThan(pull);
    expect(build).toBeGreaterThan(install);
    expect(start).toBeGreaterThan(build);
    expect(start).toBe(calls.length - 1);
  });

  test("--no-restart still stops first and never calls start", async () => {
    const { code, calls } = await runRecordedMain(["--no-restart"]);
    expect(code).toBe(0);
    const stop = calls.findIndex(c => c.includes("index.ts stop"));
    const pull = calls.findIndex(c => c.includes("pull --ff-only"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(stop);
    expect(calls.some(c => c.includes("index.ts start"))).toBe(false);
  });

  test("a stop the decision table refuses aborts before any file is touched", async () => {
    const calls: string[] = [];
    const deps: UpdateSourceDeps = {
      spawn: (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { status: 0, stdout: "" };
      },
      identityAt: async () => ({ service: "opencodex" }),
      liveness: () => "live",
    };
    const code = await main([], deps);
    expect(code).toBe(1);
    expect(calls.some(c => c.includes("pull --ff-only"))).toBe(false);
    expect(calls.some(c => c.includes("install --frozen-lockfile"))).toBe(false);
    expect(calls.some(c => c.includes("run build:gui"))).toBe(false);
  });
});
