import { REVIEW_OPEN_DIFF_TYPES } from "@plannotator/shared/review-args";

declare const __CLI_VERSION__: string;

export function version(): string {
  return `plannotator ${typeof __CLI_VERSION__ === "undefined" ? "dev" : __CLI_VERSION__}`;
}

type Topic = "review" | "annotate";
type CommonOptions = { browser?: string; title?: string; json: boolean };
export type ReviewOptions = CommonOptions & { kind: "review"; args: string[] };
export type AnnotateOptions = CommonOptions & {
  kind: "annotate";
  targets: string[];
  markdown: boolean;
  gate: boolean;
  app: boolean;
  static: boolean;
  requireApproval: boolean;
  resultFile?: string;
};

export function parseCommand(argv: readonly string[]):
  | { kind: "help"; topic?: Topic }
  | { kind: "version" }
  | ReviewOptions
  | AnnotateOptions {
  const args = [...argv];
  let browser: string | undefined;
  if (args[0] === "--browser") {
    browser = readValue(args, 0);
    args.splice(0, 2);
  }
  const [command] = args;
  if (!command || command === "--help" || command === "-h") return { kind: "help" };
  if (command === "--version" || command === "-v") return { kind: "version" };
  if (command !== "review" && command !== "annotate") {
    throw new Error(`Unknown command: ${command}. Run 'plannotator --help' for usage.`);
  }

  const reviewArgs: string[] = [];
  const targets: string[] = [];
  const seen = new Set<string>(browser === undefined ? [] : ["--browser"]);
  let title: string | undefined;
  let resultFile: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help", topic: command };
    if (arg === "--title" || arg === "--browser" || (command === "annotate" && arg === "--result-file")) {
      if (seen.has(arg)) throw new Error(`${arg} may only be specified once`);
      seen.add(arg);
      const value = readValue(args, i++);
      if (arg === "--title") title = value.replace(/\s+/g, " ").trim() || undefined;
      else if (arg === "--browser") browser = value;
      else resultFile = value;
      continue;
    }
    if (arg === "--json") {
      seen.add(arg);
      continue;
    }
    if (command === "review") {
      if (arg === "--local" || arg === "--no-local") throw new Error(`Unknown review option: ${arg}`);
      reviewArgs.push(arg);
      if (arg === "--patch-file" || arg === "--base" || arg === "--diff-type") {
        reviewArgs.push(readValue(args, i++));
      }
    } else if (["--markdown", "--render-html", "--app", "--static", "--gate", "--require-approval", "--no-jina"].includes(arg)) {
      if (arg === "--require-approval" && seen.has(arg)) throw new Error(`${arg} may only be specified once`);
      seen.add(arg);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown annotate option: ${arg}`);
    } else {
      targets.push(arg);
    }
  }
  const json = seen.has("--json");
  if (command === "review") return { kind: command, args: reviewArgs, json, browser, title };
  const gate = seen.has("--gate");
  const requireApproval = seen.has("--require-approval");
  return {
    kind: command,
    targets,
    markdown: seen.has("--markdown"),
    app: seen.has("--app"),
    static: seen.has("--static"),
    json, gate, requireApproval, resultFile, browser, title,
  };
}

function readValue(args: readonly string[], index: number): string {
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`Missing value for ${args[index]}`);
  return next;
}

export function printHelp(topic?: Topic): void {
  if (topic === "review") {
    console.log(`Usage: plannotator review [DIRECTORY] [--git | --gitbutler] [--base REF] [--diff-type TYPE] [--json] [--title TEXT] [--browser NAME]
       plannotator review --patch-file PATH|- [--json]

Review a local checkout (the current directory by default) or a unified diff.
For a pull request, check out the branch yourself and run review there.
Git diff types: ${REVIEW_OPEN_DIFF_TYPES.join(", ")}.
Use --browser none to print the session URL without opening a browser.`);
  } else if (topic === "annotate") {
    console.log(`Usage: plannotator annotate TARGET [FILE ...] [--markdown] [--app | --static] [--gate] [--json] [--title TEXT] [--browser NAME]

Annotate a file, folder, bundle of files, or HTTP(S) URL.
Loopback HTML apps open live by default; use --static for a snapshot.
--markdown converts HTML to Markdown. Web pages are fetched directly.
--gate adds an Approve action. With --gate --json:
  --require-approval  Exit 1 unless approved (exit 2 for startup errors).
  --result-file PATH  Write the JSON decision to a new file.
Use --browser none to print the session URL without opening a browser.`);
  } else {
    console.log(`Usage: plannotator <command> [options]

  review      Review local changes or a patch
  annotate    Annotate files, folders, or web pages

Run 'plannotator <command> --help' for details, or 'plannotator --version'.`);
  }
}
