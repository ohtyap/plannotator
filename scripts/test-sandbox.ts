import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { NO_BROWSER } from "../tests/helpers/no-browser";

const repo = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const split = args.indexOf("--");
const paths = split < 0 ? args : args.slice(0, split);
const flags = split < 0 ? [] : args.slice(split + 1);
if (!paths.length || flags.some((arg) => !arg.startsWith("-") || /^(-c|--config)(=|$)/.test(arg))) {
  throw new Error("Usage: bun run test:sandbox FILE [FILE ...] [-- --flag=value ...]");
}
const files = paths.map((path) => {
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  if (path.startsWith("-") || isAbsolute(rel) || rel.startsWith("..") || !statSync(absolute).isFile()) {
    throw new Error(`Expected a test file in the checkout: ${path}`);
  }
  return `./${rel.replaceAll("\\", "/")}`;
});
const root = mkdtempSync(join(tmpdir(), "plannotator-sandbox-"));
const home = join(root, "home");
const temp = join(root, "tmp");
mkdirSync(home);
mkdirSync(temp);
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  TMPDIR: temp,
  TEMP: temp,
  TMP: temp,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  PLANNOTATOR_TEST_SANDBOX: root,
  PLANNOTATOR_DATA_DIR: join(root, "data"),
  PLANNOTATOR_BROWSER: NO_BROWSER,
  PLANNOTATOR_REMOTE: "0",
  PLANNOTATOR_E2E_BINARY: resolve(repo, process.platform === "win32" ? "dist/plannotator.exe" : "dist/plannotator"),
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "win32" ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
      : process.platform === "darwin" ? join(process.env.HOME ?? "", "Library", "Caches", "ms-playwright")
      : join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright")),
};

const runner = async (argv: string[], extra?: Record<string, string>) => {
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: repo, env: { ...env, ...extra }, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

try {
  const specs = files.filter((file) => file.endsWith(".spec.ts"));
  const unit = files.filter((file) => !file.endsWith(".spec.ts"));
  if (unit.length) {
    const runDom = process.env.DOM_TESTS === "1";
    process.exitCode = await runner(["test", ...(runDom ? ["--isolate"] : []), ...flags, ...unit], runDom ? { DOM_TESTS: "1" } : undefined);
  }
  if (specs.length && !process.exitCode) {
    process.exitCode = await runner(["run", "test:e2e", ...flags, ...specs.map((file) => file.slice(2))]);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
