import pkg from "../package.json";

const [output = process.platform === "win32" ? "dist/plannotator.exe" : "dist/plannotator", target] = process.argv.slice(2);
const child = Bun.spawn([
  process.execPath, "build", "apps/cli/server/index.ts", "--compile",
  "--no-compile-autoload-bunfig", "--define", `__CLI_VERSION__=${JSON.stringify(pkg.version)}`,
  "--outfile", output, ...(target ? ["--target", target] : []),
], { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.exit(await child.exited);
