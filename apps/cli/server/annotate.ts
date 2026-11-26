import { dirname } from "node:path";
import { annotateBundleRoot } from "@plannotator/shared/annotate-bundle";
import { probeAnnotateBundlePath, resolveAnnotateBundleFiles } from "@plannotator/shared/annotate-target";
import { LIVE_APP_REMOTE_MESSAGE, LIVE_APP_REQUIRES_URL_MESSAGE } from "@plannotator/shared/live-probe";
import { startAnnotateServer, handleAnnotateServerReady } from "@plannotator/server/annotate";
import { isRemoteSession } from "@plannotator/server/remote";
import { detectProjectName } from "@plannotator/server/project";
import { setServerReadyTarget } from "@plannotator/server/shared-handlers";
import { registerSession, unregisterSession } from "@plannotator/server/sessions";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT, LIVE_BRIDGE_BOOTSTRAP } from "@plannotator/ui/components/html-viewer/bridge-script";
import { completeAnnotateCommand } from "./annotate-command";
import { createAnnotateOutcomeEmitter } from "./annotate-output";
import { resolveAnnotateTarget, type AnnotateResolutionResult } from "./annotate-resolution";
import { exitOnPortInUse } from "./port-in-use";
import { assertResultPathAvailable, resolveResultFilePath } from "./strict-annotate-result";
import { annotatePage } from "./pages";
import type { AnnotateOptions } from "./options";

export async function runAnnotate(command: AnnotateOptions): Promise<void> {
  const { app, gate, json, markdown: convertHtml, requireApproval, targets } = command;
  if ((requireApproval || command.resultFile) && !(gate && json)) {
    throw new Error("--require-approval and --result-file require --gate --json");
  }
  if (app && command.static) throw new Error("--app and --static are mutually exclusive");
  if (!targets.length) throw new Error("Missing annotation target. Run 'plannotator annotate --help' for usage.");
  const cwd = process.env.PLANNOTATOR_CWD || process.cwd();
  const resultFile = command.resultFile ? resolveResultFilePath(command.resultFile, cwd) : undefined;
  if (resultFile) await assertResultPathAvailable(resultFile);

  const resolveOne = (rawFilePath: string) => resolveAnnotateTarget({
    rawFilePath, projectRoot: cwd, noJina: true, renderMarkdown: convertHtml,
    forceApp: app, forceStatic: command.static,
  });
  let resolution: AnnotateResolutionResult;
  if (targets.length === 1) {
    resolution = await resolveOne(targets[0]!);
  } else {
    if (app) throw new Error(LIVE_APP_REQUIRES_URL_MESSAGE);
    const candidates = targets.map((target) => probeAnnotateBundlePath(target, cwd));
    const missing = targets.filter((_, i) => candidates[i] == null);
    if (missing.length) throw new Error(`A bundle requires existing file paths: ${missing.join(", ")}`);
    const paths = [...new Set(candidates as string[])];
    if (paths.length === 1) {
      resolution = await resolveOne(paths[0]!);
    } else {
      const checked = resolveAnnotateBundleFiles(paths, { convertHtml });
      if (!checked.ok) throw new Error(checked.message);
      resolution = {
        ok: true,
        markdown: "",
        absolutePath: annotateBundleRoot(checked.files.map((file) => file.path)),
        annotateMode: "annotate-bundle",
        bundleFiles: checked.files,
        sourceConverted: false,
        isUrl: false,
      };
    }
  }
  if (!resolution.ok) throw new Error(resolution.message);
  const { absolutePath, liveApp, bundleFiles, folderPath, isUrl, rawHtml } = resolution;
  const remote = isRemoteSession();
  if (liveApp && remote) throw new Error(LIVE_APP_REMOTE_MESSAGE);
  const target = bundleFiles?.map((file) => file.path) ?? folderPath ?? absolutePath;
  setServerReadyTarget(target);
  const project = (await detectProjectName(cwd)) ?? "_unknown";
  const server = await exitOnPortInUse(startAnnotateServer, (message) => { throw new Error(message); })({
    filePath: absolutePath,
    markdown: resolution.markdown,
    mode: liveApp ? "annotate-app" : resolution.annotateMode,
    liveApp: liveApp ? {
      targetUrl: absolutePath, bridgeScript: BRIDGE_SCRIPT,
      bridgeBootstrap: LIVE_BRIDGE_BOOTSTRAP, annotationCss: ANNOTATION_HIGHLIGHT_CSS,
    } : undefined,
    folderPath, bundleFiles, rawHtml, convertHtml, gate,
    renderHtml: !!rawHtml,
    sourceInfo: resolution.sourceInfo,
    sourceConverted: resolution.sourceConverted,
    title: command.title,
    sharingEnabled: false,
    approvalNotesSupported: gate,
    clientLeaseSupported: gate && json && !remote,
    agentCwd: isUrl ? cwd : bundleFiles || folderPath ? absolutePath : dirname(absolutePath),
    project,
    htmlContent: annotatePage(),
    onReady: handleAnnotateServerReady,
  });
  registerSession({ pid: process.pid, port: server.port, url: server.url, mode: "annotate", project, startedAt: new Date().toISOString(), label: `annotate-${project}` });
  process.once("exit", () => unregisterSession());
  if (server.liveProxyPort !== undefined) console.error(`Live app: ${absolutePath} (proxy port ${server.liveProxyPort})`);
  const emit = createAnnotateOutcomeEmitter({ hook: false, json });
  await completeAnnotateCommand({
    waitForDecision: server.waitForDecision,
    settleAfterDecision: () => Bun.sleep(1500),
    stopServer: server.stop,
    requireApproval, resultFile,
    emitLegacyOutcome: (outcome) => emit(outcome, {
      context: Array.isArray(target) ? `Files: ${target.join(", ")}` : `${folderPath ? "Folder" : isUrl ? "URL" : "File"}: ${target}`,
      target,
    }),
  });
}
