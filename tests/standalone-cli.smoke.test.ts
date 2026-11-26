import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_BROWSER } from "./helpers/no-browser";

const binary = resolve(process.env.PLANNOTATOR_TEST_BINARY ??
  (process.platform === "win32" ? "dist/plannotator.exe" : "dist/plannotator"));
beforeAll(() => {
  if (!existsSync(binary)) throw new Error(`Build the CLI first with bun run build:cli: ${binary} was not found`);
});
const patch = "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-before\n+after\n";

async function withSandbox(fn: (cwd: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "plannotator-cli-smoke-"));
  const home = join(cwd, "home");
  mkdirSync(home);
  try {
    await fn(cwd, {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      PLANNOTATOR_DATA_DIR: join(cwd, "data"),
      PLANNOTATOR_TEST_SANDBOX: cwd,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_READY_FILE: join(cwd, "ready.jsonl"),
      PLANNOTATOR_OPENCODE_URL: "",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([binary, ...args], { cwd, env, windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  return { code, stdout, stderr };
}

async function withSession(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  fn: (url: string) => Promise<void>,
  stdin?: string,
) {
  const child = Bun.spawn([binary, ...args], {
    cwd, env, windowsHide: true, stdout: "pipe", stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const output = Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  try {
    let url: string | undefined;
    for (let i = 0; i < 150 && child.exitCode === null; i++) {
      try {
        url = JSON.parse(readFileSync(env.PLANNOTATOR_READY_FILE!, "utf8").trim()).url;
        if (url) break;
      } catch { /* The session has not written its ready file yet. */ }
      await Bun.sleep(50);
    }
    if (!url) {
      if (child.exitCode === null) child.kill();
      throw new Error(`Session did not start: ${(await output)[2]}`);
    }
    const page = await fetch(url);
    expect(page.ok).toBe(true);
    expect(await page.text()).toContain('id="root"');
    await fn(url);
    const [code, stdout, stderr] = await output;
    return { code, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, windowsHide: true });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function api(url: string, path: string) {
  return fetch(new URL(path, url));
}

function post(url: string, path: string, body: unknown) {
  return fetch(new URL(path, url), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("unsupported commands and PR URLs fail before starting a session", async () => {
  await withSandbox(async (cwd, env) => {
    for (const args of [
      ["update"], ["inbox"], ["shape"], ["archive"], ["annotate-last"], ["opencode-review"], ["annotate", "test.md", "--hook"],
      ["review", "https://github.com/org/repo/pull/12"], ["review", "--local"],
    ]) {
      const result = await run(args, cwd, env);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.stderr).not.toContain("session ready:");
    }
    const version = await run(["--version"], cwd, env);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^plannotator \d+\.\d+\.\d+/);
  });
});

test("review and annotate preserve but ignore retired settings", async () => {
  const cases = [
    { args: ["review", "--patch-file", "-", "--json"], path: "/api/diff", stdin: patch, body: { approved: true, annotations: [] } },
    { args: ["annotate", "test.md", "--json"], path: "/api/plan", body: { annotations: [], feedback: "A note." } },
  ];
  for (const { args, path, stdin, body } of cases) {
    await withSandbox(async (cwd, env) => {
      const configFile = join(env.PLANNOTATOR_DATA_DIR!, "config.json");
      mkdirSync(env.PLANNOTATOR_DATA_DIR!);
      const priorDefaults = { jj: { defaultDiffType: "jj-line" } };
      const oldAgentSettings = { agentSwitch: { switchTo: "custom", customName: "Retired" }, agentTool: true, agentTerminalSide: "right" };
      writeFileSync(configFile, JSON.stringify({
        autoUpdate: true, updateCheck: true, displayName: "Before", reviewDefaults: priorDefaults, ...oldAgentSettings,
      }));
      writeFileSync(join(cwd, "test.md"), "# Test");
      const result = await withSession(args, cwd, env, async (url) => {
        const data = await (await api(url, path)).json();
        expect(data.serverConfig).not.toHaveProperty("autoUpdate");
        expect(data.serverConfig).not.toHaveProperty("updateCheck");
        expect(data.serverConfig).not.toHaveProperty("displayName");
        expect(data.serverConfig).not.toHaveProperty("gitUser");
        expect(data.serverConfig).not.toHaveProperty("reviewDefaults");
        for (const key of Object.keys(oldAgentSettings)) expect(data.serverConfig).not.toHaveProperty(key);
        expect(data).not.toHaveProperty("updateAvailable");
        if (path === "/api/plan") expect(data).not.toHaveProperty("repoInfo");
        expect((await post(url, "/api/update", {})).status).toBe(404);
        expect((await post(url, "/api/config", {
          autoUpdate: false, updateCheck: false, displayName: "After", favicon: "yellow",
          reviewDefaults: { jj: { defaultDiffType: "jj-all" } },
          agentSwitch: "invalid", agentTool: false, agentTerminalSide: "left",
        })).ok).toBe(true);
        expect(JSON.parse(readFileSync(configFile, "utf8"))).toMatchObject({
          autoUpdate: true, updateCheck: true, displayName: "Before", favicon: "yellow", reviewDefaults: priorDefaults, ...oldAgentSettings,
        });
        expect((await post(url, "/api/feedback", { ...body, serverSession: data.serverSession })).ok).toBe(true);
      }, stdin);
      expect(result.code).toBe(0);
    });
  }
});

test("review does not open a Jujutsu-only checkout", async () => {
  await withSandbox(async (cwd, env) => {
    mkdirSync(join(cwd, ".jj", "repo"), { recursive: true });
    const result = await run(["review", "--json"], cwd, env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Not in a supported VCS repo");
    expect(existsSync(env.PLANNOTATOR_READY_FILE!)).toBe(false);
  });
});

test("local checkout review serves an actual working tree diff and returns selected feedback", async () => {
  await withSandbox(async (cwd, env) => {
    const repo = join(cwd, "repo with spaces");
    mkdirSync(repo);
    git(repo, env, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "demo.txt"), "before\n");
    git(repo, env, "add", ".");
    git(repo, env, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.test", "commit", "-qm", "base");
    writeFileSync(join(repo, "demo.txt"), "after\n");
    const result = await withSession(["review", "repo with spaces", "--json", "--base", "main"], cwd, env, async (url) => {
      const diff = await (await api(url, "/api/diff")).json();
      expect(diff.base).toBe("main");
      expect(diff.rawPatch).toContain("+after");
      expect(diff.prMetadata).toBeUndefined();
      expect(diff.sharingEnabled).toBe(false);
      expect((await api(url, "/api/pr-context")).status).toBe(404);
      expect((await post(url, "/api/pr-action", {})).status).toBe(404);
      expect((await post(url, "/api/fetch-base", {})).status).toBe(404);
      expect((await post(url, "/api/ai/bridge/poll", {})).status).toBe(404);
      expect((await post(url, "/api/feedback", {
        approved: false, annotations: [], feedback: "Keep the example consistent.", serverSession: diff.serverSession,
      })).ok).toBe(true);
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "annotated", message: expect.stringContaining("Keep the example consistent.") });
  });
});

test("patch stdin does not require a repository", async () => {
  await withSandbox(async (cwd, env) => {
    const result = await withSession(["review", "--patch-file", "-", "--json"], cwd, env, async (url) => {
      const diff = await (await api(url, "/api/diff")).json();
      expect(diff.sourceKind).toBe("patch");
      expect(diff.rawPatch).toBe(patch);
      expect((await post(url, "/api/feedback", { approved: true, annotations: [], serverSession: diff.serverSession })).ok).toBe(true);
    }, patch);
    expect(JSON.parse(result.stdout).decision).toBe("approved");
  });
});

test("annotate bundles preserve order and strict approval writes the same JSON to stdout and disk", async () => {
  await withSandbox(async (cwd, env) => {
    writeFileSync(join(cwd, "alpha.md"), "# Alpha");
    writeFileSync(join(cwd, "beta.md"), "# Beta");
    const result = await withSession(
      ["annotate", "beta.md", "alpha.md", "--gate", "--json", "--require-approval", "--result-file", "result.json"],
      cwd, env, async (url) => {
        const document = await (await api(url, "/api/plan")).json();
        expect(document.mode).toBe("annotate-bundle");
        expect(document.clientLease?.enabled).toBe(true);
        expect(document.approvalNotesSupported).toBe(true);
        expect(document.bundle.map((entry: { path: string }) => entry.path)).toEqual([join(cwd, "beta.md"), join(cwd, "alpha.md")]);
        expect((await post(url, "/api/save-notes", {})).status).toBe(404);
        expect((await post(url, "/api/approve", { serverSession: document.serverSession })).ok).toBe(true);
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("approved");
    expect(readFileSync(join(cwd, "result.json"), "utf8")).toBe(result.stdout);
  });
});

test("missing inputs fail as usage errors, not as a negative strict decision", async () => {
  await withSandbox(async (cwd, env) => {
    const result = await run(["annotate", "missing.md", "--gate", "--json", "--require-approval"], cwd, env);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });
});
