import "./loopback-no-proxy";
import { parseCommand, printHelp, version } from "./options";
import { runReview } from "./review";
import { runAnnotate } from "./annotate";
import { annotateStartupFailureExitCode } from "./strict-annotate-result";

const args = process.argv.slice(2);
let errorCode = 1;
try {
  const commandIndex = args[0] === "--browser" ? 2 : 0;
  if (args[commandIndex] === "annotate" && args.some((arg) => arg === "--require-approval" || arg === "--result-file")) errorCode = 2;
  const command = parseCommand(args);
  if (command.kind === "help") printHelp(command.topic);
  else if (command.kind === "version") console.log(version());
  else {
    if (command.browser !== undefined) process.env.PLANNOTATOR_BROWSER = command.browser;
    process.once("SIGINT", () => process.exit(130));
    process.once("SIGTERM", () => process.exit(143));
    if (command.kind === "review") await runReview(command);
    else {
      errorCode = annotateStartupFailureExitCode(command);
      await runAnnotate(command);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = errorCode;
}
