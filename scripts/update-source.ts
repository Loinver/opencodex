/**
 * One-command source-checkout update: stop → pull → install → build → start.
 *
 * `ocx update` deliberately refuses source checkouts (it only knows npm/pnpm
 * channels), and the manual replacement is exactly what this script automates.
 * It refuses to run anywhere except a git checkout of this repository, stops
 * before touching anything when the working tree is dirty, and fails closed at
 * the first step whose exit code is nonzero — a half-updated tree must never be
 * relaunched as if it were healthy.
 *
 * The proxy is stopped BEFORE any file it executes is replaced, matching the
 * hard invariant `ocx update` follows (`update-stop-first`): the running server
 * dynamic-imports modules, so updating under it leaves a mixed old/new process.
 * Whether the stop left a safe stopped state is decided by the shared
 * stop-decision table `ocx update` uses (#3008), so the two lanes cannot drift.
 * `ocx restart` would refuse the version skew anyway (#2701, #4249) — the
 * version is about to change — which is why the tail is a stop/start pair.
 *
 * `--proxy <url>` passes a one-shot HTTP proxy to git without writing it into
 * any config (the pattern `git -c http.proxy=… pull` already established for
 * reachability-restricted networks). `--no-restart` updates and builds but
 * leaves the proxy stopped, for CI or scripted maintenance windows.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readPid, readRuntimePort } from "../src/config/process-state";
import { pendingTeardownOutstanding } from "../src/config/pending-teardown";
import { loadConfig } from "../src/config";
import { proxyIdentityAt } from "../src/server/proxy-liveness";
import { probeProxyLiveness } from "../src/update/proxy-liveness-probe.mjs";
import { decidePostStopUpdate } from "../src/update/stop-decision.mjs";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../src/update/stop-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const CLI = resolve(repoRoot, "src/cli/index.ts");

interface Options {
  proxy?: string;
  noRestart: boolean;
}

export interface UpdateSourceDeps {
  /** Child-process runner; tests record the call order without touching the host. */
  spawn?: (cmd: string, args: readonly string[], options?: { encoding?: string }) => { status: number | null; stdout?: string };
  /** Identity probe against the captured endpoint; tests must not hit a real listener. */
  identityAt?: (port: number, opts: { hostname: string }) => Promise<unknown>;
  /** Liveness classification; tests must not hit a real listener. */
  liveness?: (port: number, hostname: string) => "live" | "dead" | "unknown";
}

function spawnChild(
  deps: UpdateSourceDeps,
  cmd: string,
  args: readonly string[],
  options?: { encoding?: string },
): { status: number | null; stdout?: string } {
  if (deps.spawn) return deps.spawn(cmd, args, options);
  const result = spawnSync(cmd, args, { cwd: repoRoot, ...(options?.encoding ? { encoding: options.encoding } : { stdio: "inherit" as const }) });
  return { status: result.status, ...(result.stdout !== undefined ? { stdout: String(result.stdout) } : {}) };
}

export function parseOptions(argv: readonly string[]): { ok: true; options: Options } | { ok: false; message: string } {
  const options: Options = { noRestart: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-restart") {
      options.noRestart = true;
    } else if (arg === "--proxy") {
      const value = argv[i + 1];
      if (!value) return { ok: false, message: "--proxy requires a URL, e.g. --proxy http://127.0.0.1:7897" };
      options.proxy = value;
      i += 1;
    } else {
      return { ok: false, message: `Unknown option: ${arg}` };
    }
  }
  return { ok: true, options };
}

/** Clean = no porcelain output. A dirty tree makes `git pull --ff-only` unsafe to attempt. */
export function isWorkingTreeClean(output: string): boolean {
  return output.trim().length === 0;
}

function run(deps: UpdateSourceDeps, label: string, cmd: string, args: readonly string[]): number {
  console.log(`\n==> ${label}`);
  const result = spawnChild(deps, cmd, args);
  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`❌ ${label} failed (exit ${code}). Later steps were skipped; the proxy is STOPPED.`);
    console.error("   Fix the failure, then run: bun run src/cli/index.ts start");
  }
  return code;
}

function capture(deps: UpdateSourceDeps, cmd: string, args: readonly string[]): string | null {
  const result = spawnChild(deps, cmd, args, { encoding: "utf8" });
  return result.status === 0 ? String(result.stdout ?? "") : null;
}

export async function main(argv: readonly string[], deps: UpdateSourceDeps = {}): Promise<number> {
  if (!existsSync(resolve(repoRoot, ".git"))) {
    console.error("❌ Not a git checkout. bun run update:source works only in a cloned opencodex repository.");
    return 1;
  }
  const parsed = parseOptions(argv);
  if (!parsed.ok) {
    console.error(`❌ ${parsed.message}`);
    console.error("Usage: bun run update:source [--proxy <url>] [--no-restart]");
    return 2;
  }
  const { proxy, noRestart } = parsed.options;

  const status = capture(deps, "git", ["status", "--porcelain"]);
  if (status === null) {
    console.error("❌ git status failed; refusing to continue.");
    return 1;
  }
  if (!isWorkingTreeClean(status)) {
    console.error("❌ Working tree is dirty. Commit or stash first; this command does not merge.");
    return 1;
  }

  // Capture the listen endpoint BEFORE stop clears runtime state — same contract
  // as runUpdate — so the post-stop liveness check asks the endpoint the proxy
  // actually served, not just the configured one.
  const config = loadConfig();
  const runtime = readRuntimePort();
  const pid = readPid();
  const runtimeTrusted = !!(runtime && pid && runtime.pid === pid);
  const port = runtimeTrusted ? runtime.port : (typeof config.port === "number" && config.port > 0 ? config.port : 10100);
  const hostname = (runtimeTrusted ? runtime.hostname : undefined) ?? config.hostname ?? "127.0.0.1";

  // Stop FIRST: the pull and build replace files the running proxy dynamic-imports.
  // `ocx restart` would refuse the version skew (#2701, #4249), so this is a stop
  // followed by a start, with the shared decision table deciding whether the stop
  // was safe enough to proceed under (#3008).
  console.log("\n==> ocx stop (never replace files under a live proxy)");
  const stop = spawnChild(deps, process.execPath, [CLI, "stop"]);
  const identity = deps.identityAt ? await deps.identityAt(port, { hostname }) : await proxyIdentityAt(port, { hostname });
  const decision = decidePostStopUpdate({
    status: stop.status,
    hasRuntimeState: !!(readPid() || readRuntimePort()),
    teardownOutstanding: pendingTeardownOutstanding(),
    liveness: identity ? "live" : (deps.liveness ? deps.liveness(port, hostname) : probeProxyLiveness(port, hostname)),
  });
  if (!decision.proceed) {
    console.error(`❌ ocx stop did not leave a safe stopped state (${decision.reason}); no files were changed.`);
    console.error("   Run 'bun run src/cli/index.ts stop' manually, resolve the message, then retry.");
    return 1;
  }
  if (decision.reason === "history-only") {
    console.warn(`⚠️  Stop completed with exit ${STOP_HISTORY_INCOMPLETE_EXIT_CODE}: a Codex history manifest is waiting for review.`);
  }

  const pullArgs = ["pull", "--ff-only"];
  const git = proxy ? ["git", "-c", `http.proxy=${proxy}`, ...pullArgs] : ["git", ...pullArgs];
  let code = run(deps, "git pull --ff-only", git[0]!, git.slice(1));
  if (code !== 0) return code;

  code = run(deps, "bun install --frozen-lockfile", process.execPath, ["install", "--frozen-lockfile"]);
  if (code !== 0) return code;

  code = run(deps, "bun run build:gui", process.execPath, ["run", "build:gui"]);
  if (code !== 0) return code;

  if (noRestart) {
    console.log("\n✅ Update complete (--no-restart: proxy left stopped). Start it with: bun run src/cli/index.ts start");
    return 0;
  }

  code = run(deps, "ocx start", process.execPath, [CLI, "start"]);
  if (code !== 0) return code;

  console.log("\n✅ Source update complete: stopped, pulled, built, and running.");
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
