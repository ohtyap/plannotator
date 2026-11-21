import { resolve } from "node:path";
import { GIT_REPO_ENV } from "@plannotator/shared/child-env";
import { loadConfig, resolveDefaultDiffType, resolveDefaultDiffTypeFor } from "@plannotator/shared/config";
import { parseReviewArgs, resolveReviewTarget, withReviewDirectory } from "@plannotator/shared/review-args";
import { listBranches } from "@plannotator/shared/review-core";
import { resolveReviewOpenState } from "@plannotator/shared/review-open-state";
import { startReviewServer, handleReviewServerReady, type ReviewServerOptions } from "@plannotator/server/review";
import { buildLocalWorkspaceReview } from "@plannotator/server/review-workspace";
import { detectManagedVcs, gitRuntime, prepareLocalReviewDiff } from "@plannotator/server/vcs";
import { detectProjectName } from "@plannotator/server/project";
import { setServerReadyTarget } from "@plannotator/server/shared-handlers";
import { registerSession, unregisterSession } from "@plannotator/server/sessions";
import { loadEmbeddedDiagramEngine } from "./diagram-engine";
import { loadEmbeddedSemDiff } from "./sem-diff";
import { reviewPage } from "./pages";
import { buildReviewOutput } from "./review-output";
import { exitOnPortInUse } from "./port-in-use";
import type { ReviewOptions } from "./options";

export async function runReview(command: ReviewOptions): Promise<void> {
  const args = parseReviewArgs(command.args);
  if (args.prUrl) throw new Error("Review only accepts local checkouts or patches. Check out the pull request locally first.");
  if (args.errors.length) throw new Error(args.errors.join("\n"));
  if ((args.words?.length ?? 0) > 1) throw new Error("Review accepts one directory. Quote paths containing spaces.");
  if (args.patchFile && args.words?.length) throw new Error("--patch-file cannot be combined with a directory");
  const cwd = process.env.PLANNOTATOR_CWD || process.cwd();
  const target = resolveReviewTarget(args, cwd);
  if (target.ignored.length) throw new Error(`Not a review directory: ${target.ignored.join(" ")}`);
  if (target.directory) for (const name of GIT_REPO_ENV) delete process.env[name];
  let reviewCwd = target.directory ?? cwd;
  let diff: Pick<ReviewServerOptions, "rawPatch" | "gitRef" | "error" | "gitContext" | "diffType" | "initialBase" | "initialBaseExplicit" | "initialFingerprint" | "initialFileIdentities" | "workspace" | "agentCwd">;
  const config = loadConfig();
  if (args.patchFile) {
    const rawPatch = args.patchFile === "-" ? await Bun.stdin.text() : await Bun.file(resolve(cwd, args.patchFile)).text();
    if (!rawPatch.trim()) throw new Error("Static patch review requires non-empty unified-diff content.");
    diff = { rawPatch, gitRef: args.patchFile === "-" ? "stdin patch" : args.patchFile, diffType: "static-patch" };
  } else {
    const vcs = await detectManagedVcs(reviewCwd, args.vcsType);
    if (target.directory) reviewCwd = await vcs?.getRoot?.(reviewCwd) ?? reviewCwd;
    const forced = args.vcsType !== undefined && args.vcsType !== "auto";
    const providerId = vcs?.id ?? (forced ? args.vcsType : undefined);
    const isWorkspace = !vcs && !forced;
    let baseResolves: boolean | undefined;
    if (args.base && providerId === "git") {
      const probe = await gitRuntime.runGit(
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${args.base}^{commit}`],
        { cwd: reviewCwd },
      );
      baseResolves = probe.exitCode === 0;
    }
    const open = resolveReviewOpenState({
      parsed: args,
      isPRMode: false,
      isWorkspace,
      providerId: providerId === "git" || providerId === "gitbutler" || providerId === "jj" || providerId === "p4"
        ? providerId : undefined,
      resolvedDefaultDiffType: resolveDefaultDiffType(config),
      baseResolves,
      availableBranches: baseResolves === false ? await listBranches(gitRuntime, reviewCwd) : undefined,
    });
    if (open.error) throw new Error(open.error);
    for (const notice of open.notices) console.error(notice);
    const hideWhitespace = config.diffOptions?.hideWhitespace ?? false;
    if (isWorkspace) {
      const workspace = await buildLocalWorkspaceReview(reviewCwd, {
        configuredDiffType: resolveDefaultDiffType(config), hideWhitespace,
      });
      if (!workspace.repos.length) throw new Error("Not in a VCS repo and no nested Git/JJ/GitButler repositories were found.");
      diff = { ...workspace, workspace, agentCwd: workspace.root };
    } else {
      const local = await prepareLocalReviewDiff({
        cwd: reviewCwd,
        vcsType: args.vcsType,
        requestedDiffType: open.requestedDiffType,
        requestedBase: open.requestedBase,
        configuredDiffType: resolveDefaultDiffTypeFor(config, vcs?.id),
        hideWhitespace,
      });
      diff = {
        ...local,
        initialBase: open.requestedBase !== undefined || local.diffType === "jj-evolog" ? local.base : undefined,
        initialBaseExplicit: open.requestedBase !== undefined,
        initialFingerprint: local.fingerprint,
        initialFileIdentities: local.fileIdentities,
      };
    }
  }
  setServerReadyTarget(args.patchFile === "-" ? "stdin" : args.patchFile ? resolve(cwd, args.patchFile) : reviewCwd);
  const project = (await detectProjectName(reviewCwd)) ?? "_unknown";
  const server = await exitOnPortInUse(startReviewServer, (message) => { throw new Error(message); })({
    ...diff,
    project,
    title: command.title,
    includeReviewDirectory: !!target.directory,
    openStatePinned: args.base !== undefined || args.diffType !== undefined,
    sharingEnabled: false,
    approvalNotesSupported: true,
    htmlContent: reviewPage(),
    diagramEngine: loadEmbeddedDiagramEngine,
    semDiff: loadEmbeddedSemDiff,
    onReady: handleReviewServerReady,
  });
  registerSession({ pid: process.pid, port: server.port, url: server.url, mode: "review", project, startedAt: new Date().toISOString(), label: `review-${project}` });
  process.once("exit", () => unregisterSession());
  try {
    const result = await server.waitForDecision();
    await Bun.sleep(1500);
    result.feedback = withReviewDirectory(result.feedback, result.reviewDirectory);
    const output = buildReviewOutput(result, undefined);
    console.log(command.json ? JSON.stringify(output) : output.message);
  } finally {
    server.stop();
  }
}
