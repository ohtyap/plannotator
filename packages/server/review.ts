/**
 * Code Review Server
 *
 * Provides a server implementation for code review with git diff rendering.
 * Follows the same patterns as the plan server.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port or inclusive range (default: random locally, 19432 for remote)
 */

import { createPackageChangesService, MAX_PACKAGE_FILE_BYTES } from "@plannotator/shared/package-changes-service";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { homedir } from "node:os";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { decodePathSegment, MALFORMED_PATH_ERROR } from "@plannotator/shared/path-segment";
import { likelyAppHtmlEncoding, prewarmAppHtml } from "@plannotator/shared/app-html";
import { openPackedApp, packedAppResponse } from "@plannotator/shared/packed-app";
import {
  answerDiagramEngineRequest,
  createDiagramEngineAssets,
  isDiagramEngineRequest,
  type DiagramEngineSource,
} from "@plannotator/shared/diagram-engine-assets";
import {
  answerSemDiffRequest,
  createSemDiffAssets,
  isSemDiffRequest,
  type SemDiffSource,
} from "@plannotator/shared/sem-diff-assets";
import { answerSemDiffOpinionRequest, isSemDiffOpinionRequest } from "@plannotator/shared/sem-diff-opinion";
import { getPlannotatorDataDir as semDiffOpinionDataDir } from "@plannotator/shared/data-dir";
import { isRemoteSession, getServerHostname, startBunServerOnAvailablePort, buildAdvertisedUrl } from "./remote";
import { notePeer } from "./this-machine";
import { createRequestHostGuard } from "./request-host-guard";
import { withPlannotatorServerHeader } from "./plannotator-server-marker";
import { refuseCrossOriginWrite } from "./request-origin-guard";
import type { Origin } from "@plannotator/shared/agents";
import { type DiffType, type GitContext, runVcsDiff, getVcsFileContentsForDiff, getVcsFileBytesForDiff, listVcsFiles, getVcsDiffFingerprint, canStageFiles, stageFile, unstageFile, resolveVcsCwd, validateFilePath, getVcsContext, resolveAvailableDiffType, vcsOwnsDiffType, vcsSupportsSnapshot, materializeVcsSnapshot, gitRuntime } from "./vcs";
import { basename, dirname, join } from "node:path";
import { SingleFlight } from "@plannotator/shared/single-flight";
import {
  commitFamilyId,
  isSameCwdCommitSwitch,
  parseCommitDiffType,
  parseWorktreeDiffType,
  resolveBaseBranch,
  getSinceBaseSections,
  isBinaryPatchFile,
  listPatchFiles,
  STATIC_PATCH_DIFF_TYPE,
  type SinceBaseSections,
} from "@plannotator/shared/review-core";
import {
  getGitButlerContextRevision,
  getGitButlerPatchFingerprint,
} from "@plannotator/shared/gitbutler-core";
import {
  getCommitDiffInfo,
  listCommitHistory,
  type CommitDiffInfo,
} from "@plannotator/shared/commit-history";
import {
  REVIEW_IMAGE_ENDPOINT,
  REVIEW_IMAGE_READ_CONCURRENCY,
  REVIEW_IMAGE_SIZES_ENDPOINT,
  createConcurrencyLimiter,
  handleReviewImageRequest,
  handleReviewImageSizesRequest,
  reviewImageSizesAdvert,
} from "@plannotator/shared/review-image";
import {
  REVIEW_MARKDOWN_IMAGE_ENDPOINT,
  handleReviewMarkdownImageRequest,
} from "@plannotator/shared/review-markdown-image";
import type { DiffSide, FileBytesRead, RepoFileListing } from "@plannotator/shared/review-core";
import {
  REPO_FILE_ENDPOINT,
  REPO_FILES_ENDPOINT,
  REPO_FILES_STREAM_ENDPOINT,
  REPO_FILES_SEARCH_ENDPOINT,
  createRepoListingCache,
  diffFileStates,
  findRepoOnDiskChanges,
  gitIgnoredEntries,
  gitLiveSignature,
  repoLiveMode,
  handleRepoFileRequest,
  handleRepoFilesRequest,
  handleRepoFilesSearchRequest,
  type RepoFileRead,
  type RepoFilesUnavailable,
} from "@plannotator/shared/repo-files";
import { createReviewRepoWatch } from "./review-repo-watch";
import { CallFlowService } from "@plannotator/shared/call-flow";
import { CallFlowInstallCoordinator, callFlowInstallOriginAllowed } from "@plannotator/shared/call-flow-install";
import type { CallFlowInstallCoordinatorOptions } from "@plannotator/shared/call-flow-install";
import { parseCallFlowInstallRequest, resolveCallFlowInstallTargets } from "@plannotator/shared/call-flow-languages";
import type { CallFlowResponse } from "@plannotator/shared/call-flow-types";
import { type AgentJobInfo, getAgentJobAnnotationContext } from "@plannotator/shared/agent-jobs";
import { detectGeneratedFiles, detectGeneratedFilesByName } from "@plannotator/shared/generated-files";
import { getRepoInfo } from "./repo";
import { handleImage, handleUpload, handleApiNotFound, handleFavicon, handleCustomThemesScript, customThemesPage, readDraftGenerationFromBody, readDraftGenerationFromUrl, missingDraftResponse } from "./shared-handlers";
import { contentHash } from "./draft";
import { createReviewDraftSession, localGitDraftTargetKey, localReviewDraftKeys, type ReviewDraftKeys } from "@plannotator/shared/review-draft";
import { captureReviewProgress, handleReviewProgress } from "@plannotator/shared/review-progress";
import { createEditorAnnotationHandler } from "./editor-annotations";
import { createExternalAnnotationHandler } from "./external-annotations";
import { createAgentJobHandler } from "./agent-jobs";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, type WorkspaceReviewPromptContext } from "./agent-review-message";
import { buildGuideUserMessage, composeGuideMarkerPrompt, composeGuideMarkerRepairPrompt, createGuideSession, GUIDE_EMPTY_OUTPUT_ERROR } from "./guide/guide-review";
import { createGuideStoreSession, normalizeGuideTitle, SAVED_GUIDE_ID_PREFIX } from "@plannotator/shared/guide-store";
import {
  buildGuideSnapshot,
  createGuideHtml,
  detectGuideLanguages,
  guideExportFilename,
  resolveGuideViewerAssets,
  type GuideLaunchReview,
  type GuideSnapshot,
  type GuideSnapshotSource,
} from "@plannotator/shared/guide-format";
import { GUIDE_VIEWER_MANIFEST } from "@plannotator/shared/guide-viewer-manifest";
import {
  composeMarkerReviewPrompt,
  parseMarkerReviewText,
  transformMarkerFindings,
  makeMarkerNonce,
  extractMarkerNonce,
} from "./marker-review";
import { cookieHostConfigWrite, loadConfig, saveConfig, getServerConfig, parsePackageChangesConfig, parseReviewAnalysisConfig, resolvePackageLookup, resolveFeedbackHistory, resolveGuideHistory, resolveReviewProgress } from "./config";
import { appendFeedbackRecord, countChangedFiles, deriveFeedbackProject, type FeedbackDecision, type FeedbackReviewTarget } from "@plannotator/shared/feedback-archive";
import { isFaviconStyle, type FaviconStyle } from "@plannotator/shared/favicon";
import { createAIRuntime } from "./ai-runtime";
import { assertTestHome } from "./test-home-guard";
import { checkServerSession, createServerSessionNonce, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { isAIEndpointPath, isLongLivedAIEndpointPath, type AIEndpoints } from "@plannotator/ai";
import { getExtraMarkdownExtensions } from "@plannotator/shared/resolve-file";
import { handleOpenInApps, handleOpenIn } from "./open-in";
import { resolveWorkspaceFilePath, type LocalWorkspaceReview, type WorkspaceDiffType } from "./review-workspace";
import { handleCodeNavResolve, handleCodeNavHover, extractChangedFiles } from "./code-nav";
import { readRepoFile, repoFileErrorBody, REPO_FILE_ERROR_STATUS } from "@plannotator/shared/repo-file";
import { readRepoWorkingTreeFile } from "@plannotator/shared/repo-files-node";
import { decodeBunText } from "./git";
import { discoverCuratedSkills, resolveRequestedReviewProfile, listAllSkills, enableReviewSkill } from "./review-skill-loader";
import { readGuideInstructions, writeGuideInstructions } from "@plannotator/shared/guide-instructions-store";
import {
  BUILTIN_DEFAULT_PROFILE,
  type ReviewProfilesResponse,
} from "@plannotator/shared/review-profiles";

// Review ingestion completion semantics (REVIEW_OUTPUT_FAILED,
// markJobReviewFailed) now live in @plannotator/shared/agent-jobs.

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { type DiffType, type DiffOption, type GitContext, type WorktreeInfo } from "./vcs";
export { handleServerReady as handleReviewServerReady } from "./shared-handlers";

// --- Types ---

export interface ReviewServerOptions {
  /** Tests only: how many paths All files sends whole before serving one folder at a time. */
  repoFilesLazyThreshold?: number;
  /** Tests only: how often a polled live listing looks (default `REPO_LIVE_POLL_MS`). */
  repoLivePollMs?: number;
  /** Tests only: the Call flow install and Node preflight, so a test never starts a real install. */
  callFlowInstall?: Pick<CallFlowInstallCoordinatorOptions, "install" | "preflight">;
  /** Raw git diff patch string */
  rawPatch: string;
  /** Git ref used for the diff (e.g., "HEAD", "main..HEAD", "--staged") */
  gitRef: string;
  /** Error message if git diff failed */
  error?: string;
  /** The caller's `--title` (#2289): the whole tab title, in place of `<repo> · Code Review`. Absent: unchanged. */
  title?: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /**
   * Code review's diagram engine files (apps/review/diagram-engine), or a
   * function that reads them on first need. With them the server advertises
   * `diagramEngine` on `/api/diff` and serves the files under
   * `/assets/diagram-engine/`, and Markdown previews and guide overviews draw
   * Mermaid and Graphviz fences; without them (absent, or the read answers
   * null) the fences show as code. See @plannotator/shared/diagram-engine-assets.
   */
  diagramEngine?: DiagramEngineSource;
  semDiff?: SemDiffSource;
  /** Origin identifier for UI customization */
  origin?: Origin;
  /** Current diff type being displayed */
  diffType?: DiffType | WorkspaceDiffType;
  /** Git context with branch info and available diff options */
  gitContext?: GitContext;
  /** Local parent directory containing multiple child VCS repositories. */
  workspace?: LocalWorkspaceReview;
  /**
   * Initial base branch the caller used to compute `rawPatch`. When a caller
   * overrides the detected default (e.g. Pi's `openCodeReview` accepting a
   * custom `defaultBranch`), this must be forwarded so the server's internal
   * `currentBase` state, the `/api/diff` response, and downstream agent
   * prompts stay consistent with the patch that's already on screen.
   */
  initialBase?: string;
  /**
   * The caller pinned `initialBase` deliberately (a `--base` flag / an
   * explicit programmatic choice), not merely as the base its initial patch
   * happened to use. Seeds `baseExplicitlyChosen`: canonicalization off,
   * startup upgrade suppressed. Additive and opt-in — Pi's plain
   * forward-the-local-name-and-let-it-upgrade behavior is unchanged without
   * it.
   */
  initialBaseExplicit?: boolean;
  /**
   * The caller pinned this session's opening diff type and/or base (CLI
   * flags). Echoed on `/api/diff` so the client must not auto-switch the diff
   * on mount, and must not self-heal the persisted panel-view pair: the caller
   * already answered that question for this session, and the answer is
   * deliberately not persisted.
   */
  openStatePinned?: boolean;
  /** Freshness token captured atomically with the initial provider patch. */
  initialFingerprint?: string;
  initialFileIdentities?: Record<string, string>;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /**
   * Whether this session's decision consumer delivers approve-time feedback
   * (decision-control spec §6.4). Echoed as `approvalNotesSupported` on every
   * diff payload (`/api/diff`, `/api/diff/switch`, `/api/pr-diff-scope`,
   * `/api/pr-switch`) so the advert survives a diff switch; the client gates
   * its approve-carrying menu items on it. Default false — a caller that does
   * not pass it (an older consumer whose approved branch still discards
   * `result.feedback`) advertises "not capable" and the client renders no
   * approve-carrying items, exactly the pre-PR5 behavior.
   */
  approvalNotesSupported?: boolean;
  /** Custom base URL for share links (default: https://share.plannotator.ai) */
  shareBaseUrl?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
  /**
   * Detected project name, used to key the durable feedback archive
   * (`feedback/{project}/`). Mirrors the annotate server's `project` option.
   * Callers should pass `detectProjectName()`; without it the server falls
   * back to deriving a name from the review's working directory, which is
   * wrong in PR mode (no `gitContext`, and `--local` points `agentCwd` at a
   * `pool/pr-<n>` checkout, so records would bucket under `pr-123`).
   */
  project?: string;
  /** Return the active local directory with the decision for cross-directory feedback. */
  includeReviewDirectory?: boolean;
  /** Override the working directory for agent processes. */
  agentCwd?: string;
  /** Cleanup callback invoked when server stops (e.g., remove temp worktree) */
  onCleanup?: () => void | Promise<void>;
}

export interface ReviewServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user review decision */
  waitForDecision: () => Promise<{
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    /** The host closed the session (`POST /api/host/close`): an `exit` that keeps the draft. */
    closedBy?: "agent";
    /** With `closedBy`: the reviewer's unsent comments kept in the draft. */
    unsentAnnotations?: number;
    /** The review was posted to the PR platform (`POST /api/pr-action`); `feedback` is only its status line. */
    platform?: true;
    /**
     * What the decision is about, as the server shows it NOW: the active PR's
     * URL (after any in-place `/api/pr-switch`), the workspace root, or the
     * working tree the active diff reads (a worktree diff type moves it).
     * Absent for a static patch (the caller knows the file).
     */
    target?: string;
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

/**
 * Start the Code Review server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/diff, /api/feedback)
 * - Port conflict retries
 */
export async function startReviewServer(
  options: ReviewServerOptions
): Promise<ReviewServerResult> {
  assertTestHome();
  const { htmlContent, origin, gitContext, sharingEnabled = true, shareBaseUrl, onReady } = options;
  // Session-constant capability advert; rides every diff payload (see the
  // option's doc). Absent option = false, so old callers advertise honestly.
  const approvalNotesSupported = options.approvalNotesSupported === true;
  // Stale-tab guard (packages/core/server-session.ts): advertised beside
  // approvalNotesSupported on every diff payload and echoed by every
  // decision; a different nonce is refused with 409 session_mismatch before
  // anything settles. Missing is accepted (older clients).
  const serverSession = createServerSessionNonce();
  // Static patch mode (`plannotator review --patch-file`): the diff is
  // caller-supplied bytes, so there is no repo, no working tree and no VCS
  // behind it. Advertised to the client as `sourceKind: "patch"` on every diff
  // payload (absent reads as "vcs"), and enforced here by 400ing the endpoints
  // that would otherwise resolve patch paths against whatever cwd the server
  // happens to run in.
  const isStaticPatchMode = options.diffType === STATIC_PATCH_DIFF_TYPE;
  // Image preview capability advert (#1598), beside approvalNotesSupported on
  // every diff payload. Off where nothing can be read: a static patch has
  // no repository, and P4 drops binary files from its patch entirely.
  const imagePreviewSupported = !isStaticPatchMode && gitContext?.vcsType !== "p4";
  // Markdown preview capability advert: the preview renders the full file, so
  // it is offered wherever /api/file-content can read one (never a static
  // patch). Its images (/api/review-markdown-image) follow imagePreviewSupported.
  const markdownPreviewSupported = !isStaticPatchMode;
  // All files (the review tree's whole repository) capability advert, beside
  // markdownPreviewSupported on every diff payload. A session that has it can
  // still answer `available: false` (a PR without a checkout whose platform
  // cannot list, a listing that failed); the tree then says why.
  const repoFilesSupported = !isStaticPatchMode && gitContext?.vcsType !== "p4";
  const runImageRead = createConcurrencyLimiter(REVIEW_IMAGE_READ_CONCURRENCY);
  const sourceKindAdvert = isStaticPatchMode
    ? ({ sourceKind: "patch" } as const)
    : ({} as Record<string, never>);
  const workspace = options.workspace;
  const isWorkspaceMode = !!workspace;
  const hasLocalAccess = !!gitContext;
  const sessionVcsType = gitContext?.vcsType;
  let clientGitContext = gitContext;
  let draftKey = contentHash(options.rawPatch);
  const editorAnnotations = createEditorAnnotationHandler();
  const externalAnnotations = createExternalAnnotationHandler("review");

  const guide = createGuideSession();
  // Durable guide persistence (#1112): autosaves validated guides to
  // ${PLANNOTATOR_DATA_DIR}/guides/{repo-key}/ and serves them back through
  // the existing guide endpoints as `saved:{id}` pseudo job ids. All getters
  // are late-bound because the current diff can change mid-session.
  const guideStore = createGuideStoreSession({
    runGit: async (args, cwd) => {
      const result = await gitRuntime.runGit(args, { cwd });
      return result.exitCode === 0 ? result.stdout : null;
    },
    getGitCwd: () =>
      isWorkspaceMode
        ? undefined
        : gitContext
          ? resolveVcsCwd(currentDiffType as DiffType, gitContext.cwd) ?? gitContext.cwd ?? process.cwd()
          : undefined,
    getPRInfo: () => null,
    getBranchLabel: () => clientGitContext?.currentBranch || gitContext?.currentBranch,
    getFallbackDir: () => workspace?.root ?? options.agentCwd ?? process.cwd(),
    writesEnabled: () => resolveGuideHistory(loadConfig()),
  });

  /** Job fields the store persists for export provenance (engine/model already on the job). */
  const guideSaveJob = (job: AgentJobInfo) => ({
    id: job.id,
    engine: job.engine,
    model: job.model,
    generatedAt: job.endedAt ?? Date.now(),
  });

  /**
   * Snapshot for exporting a guide: `saved:{id}` → the store; a live job →
   * this session's launch review + guide (the persisted copy is the fallback,
   * e.g. when the in-memory review was evicted).
   */
  async function resolveGuideSnapshotForExport(jobId: string): Promise<GuideSnapshot | null> {
    if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
      return guideStore.getSavedGuideSnapshot(jobId.slice(SAVED_GUIDE_ID_PREFIX.length));
    }
    const live = guide.getGuide(jobId);
    const launchReview = guide.getLaunchReview(jobId);
    if (live && launchReview) {
      const job = agentJobs.getJob(jobId);
      return buildGuideSnapshot({
        guide: live,
        reviewed: live.reviewed,
        review: launchReview,
        generator: {
          engine: job?.engine,
          model: job?.model,
          generatedAt: job?.endedAt ? new Date(job.endedAt).toISOString() : undefined,
        },
      });
    }
    return guideStore.getJobGuideSnapshot(jobId);
  }

  // Mutable state for diff switching
  let currentPatch = options.rawPatch;
  let currentFileIdentities = options.initialFileIdentities;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType | WorkspaceDiffType = options.diffType || workspace?.diffType || "uncommitted";
  let currentError = options.error;
  let currentHideWhitespace = loadConfig().diffOptions?.hideWhitespace ?? false;
  // Draft keys for the displayed snapshot. Identity is captured with it so a
  // subsequent checkout cannot silently redirect draft writes.
  const reviewDrafts = createReviewDraftSession();
  let localDraftTarget: string | null = null;
  const currentDraftKeys = (): ReviewDraftKeys => {
    const patchKey = draftKey;
    return localReviewDraftKeys(patchKey, localDraftTarget);
  };
  // Monotonic guard for /api/diff/switch: concurrent switches mutate shared
  // state across awaits, so a slower earlier request could overwrite a newer
  // one's snapshot and hand the client a self-consistent-but-wrong diff. A
  // superseded request writes nothing and returns { superseded: true }.
  let diffSwitchEpoch = 0;
  // Analysis-setting requests can overlap each other and view switches. Older
  // responses must never re-advertise capabilities for a superseded view.
  let reviewAnalysisEpoch = 0;
  let reviewAnalysisMutationEpoch: number | null = null;
  // Tracks the base branch the user picked from the UI. Agent review prompts
  // read this (not gitContext.defaultBranch) so they analyze the same diff
  // the reviewer is currently looking at. Honors an explicit initialBase from
  // the caller — e.g. programmatic Pi callers can request a non-detected base.
  const detectedCompareTarget = (): string => gitContext?.defaultBranch || gitContext?.compareTarget?.fallback || "main";
  let currentBase = options.initialBase || detectedCompareTarget();
  const isGitButlerCommittedView = (diffType: string = currentDiffType as string): boolean =>
    diffType.startsWith("gitbutler:stack:") || diffType.startsWith("gitbutler:branch:");
  // True once the user picks a base from the picker (explicitBase on the
  // switch body). Disables the bare-local-name → origin/* canonicalization:
  // the picker offers local and remote refs as distinct choices, so an
  // explicit local pick must be honored even when the two point at
  // different commits. A caller-pinned base (`--base` via
  // initialBaseExplicit) seeds it for the same reason.
  let baseExplicitlyChosen = options.initialBaseExplicit === true;

  // --- Diff staleness fingerprint -------------------------------------------
  // Captured beside every patch snapshot (startup + every switch endpoint);
  // GET /api/diff/fresh recomputes and compares so the client can show a
  // "diff out of date — refresh" notice when files change mid-review (e.g. an
  // agent editing/committing while the user reviews). Best-effort everywhere:
  // null means "cannot fingerprint" and is reported as fresh, never stale.
  let currentFingerprint = options.initialFingerprint ?? getGitButlerPatchFingerprint(
      currentDiffType as DiffType,
      currentPatch,
      clientGitContext,
    );
  const computeDiffFingerprint = async (): Promise<string | null> => {
    try {
      if (workspace) return await workspace.getFingerprint();
      if (!hasLocalAccess) return null;
      return await getVcsDiffFingerprint(currentDiffType as DiffType, currentBase, gitContext?.cwd, {
        hideWhitespace: currentHideWhitespace,
      });
    } catch {
      return null;
    }
  };
  // Fire-and-forget capture: never delays the snapshot response it describes.
  // Generation-guarded: two rapid switches can resolve their captures out of
  // order — only the LATEST capture may write the baseline, otherwise a stale
  // fingerprint would make /api/diff/fresh report stale forever.
  let fingerprintGeneration = 0;
  // All files (the review tree's whole repository): one listing per snapshot,
  // dropped when the snapshot changes or the disk does (live listings).
  const repoListing = createRepoListingCache();
  const repoWatch = createReviewRepoWatch();
  // When the diff on screen was taken: files modified after it are "changed on disk".
  let snapshotCapturedAt = Date.now();
  let pendingFingerprintCapture: Promise<string | null> | null = null;
  const fileContentFingerprintProbes = new SingleFlight<string | null>();
  const callFlowService = new CallFlowService();
  // In-app opt-in runtime install. Completion invalidates the service's
  // 30 second runtime probe cache so the very next capability advert
  // resolves available without a server restart.
  const callFlowInstall = new CallFlowInstallCoordinator({
    ...options.callFlowInstall,
    onSettled: (ok) => {
      if (ok) callFlowService.invalidateRuntimeState();
    },
  });
  // PLANNOTATOR_REVIEW_PROGRESS / config.reviewProgress: when off, no snapshot
  // exists, so the endpoint answers `available: false` without touching disk and
  // the client keeps viewed marks in the draft, as for unsupported modes.
  const captureProgress = () => !resolveReviewProgress(loadConfig()) ? Promise.resolve(null) : captureReviewProgress({
    patch: currentPatch,
    fileIdentities: currentFileIdentities,
    diffType: currentDiffType,
    base: currentBase,
    cwd: gitContext ? gitContext.cwd ?? process.cwd() : undefined,
    vcsType: sessionVcsType,
    workspaceRoot: workspace?.root,
  }, gitRuntime.runGit);
  // Captured once at startup: either by the initial fingerprint capture below
  // or, when the caller already supplied a fingerprint, right after it.
  let progressSnapshot: ReturnType<typeof captureProgress> = Promise.resolve(null);
  const captureDraftTarget = (base = currentBase) => isStaticPatchMode ? Promise.resolve(null) : localGitDraftTargetKey({
    diffType: currentDiffType,
    base,
    defaultBase: undefined,
    cwd: gitContext ? gitContext.cwd ?? process.cwd() : undefined,
    vcsType: sessionVcsType,
    workspaceRoot: workspace?.root,
  }, gitRuntime.runGit);
  const captureDiffFingerprint = (knownFingerprint?: string, knownDraftTarget?: string | null): void => {
    snapshotCapturedAt = Date.now();
    repoListing.invalidate();
    progressSnapshot = captureProgress();
    if (knownDraftTarget !== undefined) localDraftTarget = knownDraftTarget;
    // A fingerprint capture marks a committed review-view change. Stop work
    // for the prior snapshot even when the new view cannot run CallDiff.
    callFlowService.cancelAll();
    fileContentFingerprintProbes.clear();
    const generation = ++fingerprintGeneration;
    if (knownFingerprint !== undefined) {
      currentFingerprint = knownFingerprint;
      pendingFingerprintCapture = null;
      return;
    }
    // The previous snapshot's fingerprint must never be treated as the new
    // snapshot's baseline while this capture is in flight. File expansion can
    // await this exact promise when it needs a trustworthy baseline.
    currentFingerprint = null;
    const capture = computeDiffFingerprint();
    pendingFingerprintCapture = capture;
    void capture.then((fingerprint) => {
      if (generation === fingerprintGeneration) {
        currentFingerprint = fingerprint;
        pendingFingerprintCapture = null;
      }
    });
  };
  // Host control is synchronous too: resolve identity before serving, then
  // publish each new target atomically with its patch at a snapshot change.
  localDraftTarget = await captureDraftTarget();
  if (currentFingerprint === null) captureDiffFingerprint();
  else progressSnapshot = captureProgress();

  const resolveReviewBase = (
    requestedBase?: string,
    explicitlyChosen = baseExplicitlyChosen,
    activeBase = currentBase,
  ): string => {
    const resolved = resolveBaseBranch(requestedBase, detectedCompareTarget());
    // Preserve the selected local tracking ref when the UI echoes its bare name.
    return !explicitlyChosen && activeBase === `origin/${resolved}` ? activeBase : resolved;
  };

  // --- Since-base sections sidecar ------------------------------------------
  // Groups the composite since-base patch's files by lifecycle state
  // (committed / changes / untracked) for the three-stack panel. Only
  // computed when the since-base mode (or its worktree variant) is active.
  const isSinceBaseActive = (diffType: string = currentDiffType as string): boolean => {
    if (workspace || !gitContext) return false;
    const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
    return effective === "since-base";
  };
  // Base AND diff type are parameterized so callers can pin them to a
  // snapshot taken before an await — reading the globals inside would race
  // the startup base upgrade and concurrent diff-type switches.
  const buildSectionsSidecar = async (
    base: string = currentBase,
    diffType: string = currentDiffType as string,
  ): Promise<SinceBaseSections | undefined> => {
    if (!isSinceBaseActive(diffType)) return undefined;
    const cwd = resolveVcsCwd(diffType as DiffType, gitContext?.cwd);
    return (await getSinceBaseSections(gitRuntime, base, cwd)) ?? undefined;
  };

  // --- Commit metadata sidecar -----------------------------------------------
  // When a commit:<sha> diff is active, the full commit message (rendered as
  // markdown client-side) heads the all-files view. Same mode-conditional
  // shape as the sections sidecar; avatar enrichment reuses the session cache.
  // diffType parameterized for the same pin-before-await discipline as
  // buildSectionsSidecar.
  const buildCommitInfoSidecar = async (diffType: string = currentDiffType as string): Promise<CommitDiffInfo | undefined> => {
    if (workspace || !gitContext) return undefined;
    const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
    const sha = parseCommitDiffType(effective as string)?.sha;
    if (!sha) return undefined;
    const cwd = resolveVcsCwd(diffType as DiffType, gitContext.cwd);
    const info = await getCommitDiffInfo(gitRuntime, sha, cwd);
    return info ?? undefined;
  };

  // --- Generated-files sidecar (#1317) ---------------------------------------
  // Two-layer generated detection for the served patch's paths so the client
  // can collapse those diffs by default, GitHub-style: built-in name defaults
  // (lockfiles, minified assets — no git needed) refined by `.gitattributes`
  // `linguist-generated`, which wins in both directions (set marks, unset
  // un-marks even a built-in name, unspecified keeps the default).
  // Presentation-layer only: the patch is never filtered and snapshot/
  // fingerprint semantics are untouched. Attribute refinement runs for plain
  // local Git sessions only — PR worktrees, workspace multi-repo, jj,
  // GitButler, and P4 get the name-based defaults alone rather than guessing
  // attributes for a tree git can't authoritatively resolve here. Patch and
  // diff type are parameterized for the same pin-before-await discipline as
  // buildSectionsSidecar.
  const buildGeneratedFilesSidecar = async (
    patch: string = currentPatch,
    diffType: string = currentDiffType as string,
  ): Promise<string[] | undefined> => {
    const paths = listPatchFiles(patch).map((f) => f.path);
    const plainLocalGit =
      !workspace && gitContext && (sessionVcsType ?? "git") === "git";
    const generated = plainLocalGit
      ? await detectGeneratedFiles(
          gitRuntime,
          resolveVcsCwd(diffType as DiffType, gitContext.cwd),
          paths,
        )
      : detectGeneratedFilesByName(paths);
    return generated.length > 0 ? generated : undefined;
  };

  let serverUrl = "";
  /**
   * The review's target as it stands at decision time (named in every
   * decision a host delivers): the active PR's URL, the workspace root, or
   * the working tree the active diff reads. A static patch has none here.
   */
  const activeReviewTarget = (): string | undefined => {
    if (isStaticPatchMode) return undefined;
    if (workspace) return workspace.root;
    return resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? gitContext?.cwd ?? undefined;
  };
  const resolveAgentCwd = (): string => {
    if (workspace) return workspace.root;
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
  // Strict launch root for /api/open-in: in PR pool mode only the PR's own
  // checkout is acceptable — never the launch-repo fallback resolveAgentCwd
  // uses, which would open a file from the wrong tree. Returns [] until the
  // checkout is ready so resolveOpenInTarget rejects (the button is gated off
  // then anyway); non-PR resolves to the working tree as usual.
  const resolveOpenInRoot = (): string | string[] => {
    if (workspace) return workspace.root;
    return options.agentCwd ?? resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? process.cwd();
  };
  const getWorkspacePromptContext = (): WorkspaceReviewPromptContext | undefined => {
    if (!workspace) return undefined;
    return workspace.getPromptContext();
  };

  // GitButler's picker topology is live session state: stacks and branches can
  // change without changing the currently-rendered patch. Carry a compact
  // revision in the snapshot id so another tab cannot rebaseline the shared
  // fingerprint and make an old picker look fresh. Ordinary Git/JJ/P4 snapshot
  // ids remain byte-for-byte unchanged.
  let currentContextRevision = getGitButlerContextRevision(clientGitContext) ?? "";

  // The "changes under review" context for Ask AI, built from the CURRENT view
  // by the SAME machine the launchable review jobs use (buildCommand above) —
  // contextOnly=true so it carries only the changeset/how-to-inspect-it text, no
  // "provide findings" framing. Returned in the diff payloads so the chat can
  // latch it onto the user's messages; recomputed wherever the view changes so a
  // mid-session switch (diff type, base, whitespace, PR, scope) stays accurate.
  // Parameterized so response handlers that SNAPSHOT the served state before
  // an await can build the AI context from that same snapshot — reading the
  // live globals here would let the startup base upgrade hand Ask AI a
  // context for a different changeset than the rendered patch.
  // Snapshot identity clients echo on freshness probes: the content hash
  // PLUS the view mode. Mode is included so a cross-tab mode switch with a
  // byte-identical patch (layer vs full-stack on a single-PR stack) still
  // flags old tabs; the BASE is deliberately excluded so a same-commit base
  // canonicalization (main -> origin/main) stays banner-silent. draftKey
  // itself stays a pure content hash — drafts survive content-identical
  // mode round-trips.
  const currentSnapshotId = (): string =>
    `${draftKey}:${currentDiffType}${currentContextRevision ? `:${currentContextRevision}` : ""}${currentFileIdentities ? `:${contentHash(JSON.stringify(currentFileIdentities))}` : ""}`;

  // --- Durable feedback archive --------------------------------------------
  //
  // Code review was the headline gap: /api/feedback deleted the draft, settled
  // the decision promise, and persisted NOTHING. When the invoking agent had
  // already timed out, the review existed nowhere — the exact failure #678
  // fixed for annotate. Every submission now appends one record to
  // feedback/{project}/index.jsonl (plus a markdown sidecar when it carries
  // content) BEFORE the draft is deleted.
  //
  // Project bucketing: prefer the caller's detected project name. The cwd
  // fallback is only right for a plain local review — PR mode has no
  // gitContext, and `--local` sets agentCwd to a `pool/pr-<n>` checkout, so
  // deriving from cwd there would file every PR review under `pr-123`.
  //
  // Known limitation, deliberately not chased here: a caller that passes no
  // project AND reviews a moved/renamed working directory buckets under the
  // new directory name, exactly like the rest of the data dir does.
  const feedbackProject = (): string =>
    options.project?.trim()
      ? options.project
      : deriveFeedbackProject(gitContext?.cwd ?? options.agentCwd ?? process.cwd());

  // Diff IDENTITY only: refs, view, snapshot id, and size metadata. The patch
  // bytes are deliberately not archived (guide history already showed what
  // uncapped patch copies cost); the user can regenerate the diff from these.
  const feedbackReviewTarget = (): FeedbackReviewTarget => {
    const target: FeedbackReviewTarget = {
      diffType: String(currentDiffType),
      base: currentBase,
      gitRef: currentGitRef,
      snapshotId: currentSnapshotId(),
      changedFiles: countChangedFiles(currentPatch),
      patchBytes: currentPatch.length,
    };
    if (sessionVcsType) target.vcsType = sessionVcsType;
    else if (workspace) target.vcsType = "workspace";
    const cwd = gitContext?.cwd ?? options.agentCwd;
    if (cwd) target.cwd = cwd;
    return target;
  };

  /**
   * Append the archive record for one submission.
   *
   * Returns whether the draft delete may proceed: true when the record was
   * written, when the archive is switched off, or when there was no user
   * content to lose; false only when a durable write was expected and failed,
   * in which case the caller keeps the draft as the recovery copy.
   */
  const archiveReviewSubmission = (
    feedback: unknown,
    annotations: unknown,
    decision: FeedbackDecision,
  ): boolean => {
    if (!resolveFeedbackHistory(loadConfig())) return true;
    const feedbackText = typeof feedback === "string" ? feedback : "";
    const annotationList = Array.isArray(annotations) ? annotations : [];
    const hasContent = feedbackText.trim().length > 0 || annotationList.length > 0;
    const written = appendFeedbackRecord({
      project: feedbackProject(),
      origin,
      surface: "review",
      decision,
      target: { review: feedbackReviewTarget() },
      feedback: feedbackText,
      annotations: annotationList,
    });
    // A failed decision-only line has nothing to recover, so it must not
    // change the legacy draft behavior.
    return written !== null || !hasContent;
  };

  const buildCurrentAiReviewContext = (
    patch: string = currentPatch,
  ): string | undefined => {
    if (!openCode) return undefined;
    const boundedPatch = patch.length > 300_000 ? `${patch.slice(0, 300_000)}\n[Remaining patch omitted.]` : patch;
    const workspacePrompt = getWorkspacePromptContext();
    if (workspacePrompt) {
      return buildAgentReviewUserMessageForTarget(
        { kind: "workspace", patch: boundedPatch, workspace: workspacePrompt },
        true,
      );
    }
    return buildAgentReviewUserMessage(boundedPatch, "static-patch", undefined, undefined, true);
  };
  const callFlowEnabled = (): boolean => loadConfig().reviewAnalysis?.callFlow === true;

  const getCallFlowAdvert = (
    diffType: DiffType = currentDiffType as DiffType,
    enabled = callFlowEnabled(),
  ) =>
    callFlowService.getAdvert(enabled, {
      snapshotSupported: !workspace && vcsSupportsSnapshot(sessionVcsType ?? "git", diffType),
      rawPatch: currentPatch,
    });

  const getCallFlow = async (url: URL): Promise<CallFlowResponse> => {
    const requestedSnapshot = url.searchParams.get("snapshot");
    if (!requestedSnapshot || requestedSnapshot !== currentSnapshotId()) {
      return { status: "stale", reason: "snapshot-mismatch", message: "The review changed before call flow could start. Refresh and try again." };
    }
    if (!callFlowEnabled()) {
      return { status: "disabled", reason: "disabled", message: "Call flow is disabled in Settings → Analysis." };
    }
    if (workspace) {
      return { status: "unsupported", reason: "workspace-unsupported", message: "Call flow does not yet support multi-repository workspace reviews." };
    }
    const advert = await getCallFlowAdvert();
    if (advert.state === "unsupported") {
      return {
        status: "unsupported",
        reason: advert.reason ?? "view-unsupported",
        message: advert.message ?? "Call flow is not available for this review view.",
      };
    }

    let analysisCwd: string | undefined;
    let analysisDiffType = currentDiffType as string;
    let analysisBase = currentBase;
    analysisCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd)
      ?? gitContext?.cwd
      ?? options.agentCwd
      ?? process.cwd();
    if (!analysisCwd) {
      return { status: "unavailable", reason: "checkout-unavailable", message: "Call flow requires a local Git checkout." };
    }

    const baseline = pendingFingerprintCapture ? await pendingFingerprintCapture : currentFingerprint;
    const before = await computeDiffFingerprint();
    if (requestedSnapshot !== currentSnapshotId() || (baseline && before && baseline !== before)) {
      return { status: "stale", reason: "snapshot-stale", message: "The files changed before call flow could start. Refresh the review first." };
    }
    const analysisVcsType = sessionVcsType ?? "git";
    return callFlowService.analyze({
      snapshotId: requestedSnapshot,
      rawPatch: currentPatch,
      snapshot: {
        materialize: ({ includedExtensions, signal }) => materializeVcsSnapshot(analysisVcsType, {
          cwd: analysisCwd,
          diffType: analysisDiffType as DiffType,
          base: analysisBase,
          rawPatch: currentPatch,
          includedExtensions,
          signal,
        }),
      },
      verifySnapshot: async () => {
        const after = await computeDiffFingerprint();
        return requestedSnapshot === currentSnapshotId() && !(before && after && before !== after);
      },
    });
  };

  const aiRuntime = await createAIRuntime({ cwd: resolveAgentCwd(), getCwd: resolveAgentCwd });
  const openCode = aiRuntime?.openCode;
  const agentJobs = createAgentJobHandler({
    generate: openCode ? (prompt, cwd, signal) => openCode.generate(prompt, cwd, signal) : undefined,
    serverSession,

    async prepare(provider, config) {
      // Snapshot the active diff before any await so the job and its findings
      // refer to the same changes even if the reviewer switches views.
      const cwd = resolveAgentCwd();
      const launchPatch = currentPatch;
      const launchDiffType = currentDiffType;
      const launchBase = currentBase;
      const launchGitRef = currentGitRef;
      const launchSnapshotId = currentSnapshotId();
      const launchWorkspacePrompt = getWorkspacePromptContext();

      const requestedProfileId =
        typeof config?.reviewProfileId === "string" ? config.reviewProfileId : undefined;
      // Resolve the requested review, or throw a clear error. An unresolvable
      // non-default id (renamed/removed skill, stale cookie, malformed request)
      // never silently downgrades to the default — explicit selection is
      // authoritative at this boundary.
      const reviewProfile = resolveRequestedReviewProfile(requestedProfileId);

      const workspacePrompt = launchWorkspacePrompt;
      const userMessageOptions = {
        defaultBranch: launchBase,
        ...(workspacePrompt && { workspace: workspacePrompt }),
      };

      // Snapshot the diff context at launch — stored on the job so
      // downstream "Copy All" produces the same markdown as /api/feedback
      // would right now, even if the reviewer switches modes/bases later.
      const worktreeParts = String(launchDiffType).startsWith("worktree:")
        ? parseWorktreeDiffType(launchDiffType as DiffType)
        : null;
      const diffContext: AgentJobInfo["diffContext"] | undefined = workspacePrompt
        ? { mode: String(launchDiffType), worktreePath: null }
        : {
            mode: (worktreeParts?.subType ?? launchDiffType) as string,
            base: launchBase,
            worktreePath: worktreeParts?.path ?? null,
            ...(String(launchDiffType).startsWith("gitbutler:") && {
              label: launchGitRef,
              snapshotId: launchSnapshotId,
            }),
          };

      if (provider === "guide") {
        // The changed-file list is derived from the same launch-time patch
        // snapshot as the rest of this closure — it's what the model plans
        // section placement against at generation time. The SAME list is
        // snapshotted onto the job (changedFilesSnapshot, below) and reused
        // by onJobComplete to validate refs, rather than re-deriving from
        // whatever patch/diff/base the reviewer has switched to by the time
        // the job finishes — a mid-generation diff/base switch would
        // otherwise invalidate every ref in an otherwise-valid guide.
        const changedFiles = listPatchFiles(launchPatch);

        const repairOf = typeof config?.repairOf === "string" ? config.repairOf : undefined;
        const repair = repairOf ? guide.getFailedPayload(repairOf) : undefined;
        if (repairOf && !repair) throw new Error("No captured output to repair for that job — run the guide again instead.");
        const nonce = makeMarkerNonce();
        const prompt = repair
          ? composeGuideMarkerRepairPrompt(repair, nonce)
          : composeGuideMarkerPrompt(
              buildGuideUserMessage(launchPatch, "static-patch", userMessageOptions, undefined, changedFiles),
              nonce,
              config.instructions,
            );
        // A repair job's payload is the FAILED job's previously-captured
        // output, not this launch's diff — its file refs were validated
        // (and, for onJobComplete, must be re-validated) against the failed
        // job's own recorded changed-file set. Falling back to this launch's
        // freshly-derived `changedFiles` here would validate a repair against
        // whatever diff/base happens to be on screen right now, reintroducing
        // the destroy-on-switch bug this snapshot exists to prevent — just
        // for repairs instead of the original launch. Fall back only if the
        // failed job's set was never recorded (defensive; shouldn't happen
        // since onJobComplete always records it before returning).
        const changedFilesSnapshot = repairOf
          ? guide.getLaunchChangedFiles(repairOf) ?? changedFiles.map((f) => f.path)
          : changedFiles.map((f) => f.path);
        // Snapshot the launch-time review-target context (#1112): guide jobs
        // run for minutes while the session supports mid-generation PR/diff
        // switching, so the persisted envelope must be labeled with the
        // context this guide is GENERATED against — captured now, carried on
        // the job (guideContext), and read back at completion instead of the
        // live session state. Repairs reuse the FAILED job's own snapshot,
        // same as changedFilesSnapshot above.
        const guideContext = (repairOf ? agentJobs.getJob(repairOf)?.guideContext : undefined)
          ?? await guideStore.captureLaunchContext();
        // The review this guide describes, for portable export (decision
        // record D6): captured from the SAME launch-time snapshot as the
        // patch the model is given, never re-read at export time. Repairs
        // reuse the FAILED job's own review, like changedFilesSnapshot.
        const commitSha = commitFamilyId(String(launchDiffType)) ?? undefined;
        const launchSource: GuideSnapshotSource = workspacePrompt
          ? { kind: "workspace", ...(repoInfo?.display && { repo: repoInfo.display }) }
          : {
                kind: commitSha ? "commit" : "local",
                ...(repoInfo?.display && { repo: repoInfo.display }),
                ...(clientGitContext?.currentBranch && { branch: clientGitContext.currentBranch }),
                ...(guideContext.headSha && { headSha: guideContext.headSha }),
                ...(commitSha && { commitSha }),
              };
        const launchReview: GuideLaunchReview = (repairOf ? guide.getLaunchReview(repairOf) : null) ?? {
          rawPatch: launchPatch,
          gitRef: launchGitRef,
          diffType: String(launchDiffType),
          ...(launchBase && { base: launchBase }),
          source: launchSource,
          ...(typeof config?.instructions === "string" && config.instructions.trim() && { customInstructions: config.instructions }),
        };
        return {
          cwd: (repairOf && agentJobs.getJob(repairOf)?.cwd) || cwd,
          label: repairOf ? "Guide Repair" : "Guided Review",
          prompt,
          diffContext,
          reviewProfileId: reviewProfile.id,
          reviewProfileLabel: reviewProfile.label,
          changedFilesSnapshot,
          guideContext,
          launchReview,
        };
      }

      // A custom review skill carries its own instructions and becomes the whole
      // prompt; strip the default framing prose from the user message so only the
      // git/PR context remains. The default review keeps today's message verbatim.
      const isCustomReview = reviewProfile.source === "user";
      const userMessage = workspacePrompt
        ? buildAgentReviewUserMessageForTarget({
            kind: "workspace",
            patch: launchPatch,
            workspace: workspacePrompt,
          }, isCustomReview)
        : buildAgentReviewUserMessage(launchPatch, "static-patch", userMessageOptions, undefined, isCustomReview);
      const jobLabel = workspacePrompt ? "Workspace Review" : "Code Review";

      const prompt = composeMarkerReviewPrompt(reviewProfile, userMessage, makeMarkerNonce());
      return { prompt, cwd, label: jobLabel, diffContext, reviewProfileId: reviewProfile.id, reviewProfileLabel: reviewProfile.label };
    },

    async onJobComplete(job, meta) {
      const cwd = meta.cwd ?? resolveAgentCwd();

      // Only tag annotations with a *custom* profile — the default review needs no tag.
      const profileLabel =
        job.reviewProfileId && job.reviewProfileId !== BUILTIN_DEFAULT_PROFILE.id
          ? job.reviewProfileLabel
          : undefined;

      // Map findings onto annotations and ingest. Shared by both engine branches;
      // no-ops on an empty set so a clean (zero-finding) review stays "done".
      const ingest = <T extends object>(transformed: readonly T[], logTag: string) => {
        if (transformed.length === 0) return undefined;
        const annotations = transformed.map((a) => ({
          ...a,
          ...getAgentJobAnnotationContext(job.diffContext),
          ...(profileLabel && { reviewProfileLabel: profileLabel }),
        }));
        const result = externalAnnotations.addAnnotations({ annotations });
        if ("error" in result) console.error(`[${logTag}] addAnnotations error:`, result.error);
        return result;
      };

      if (job.provider === "opencode") {
        const nonce = extractMarkerNonce(job.prompt ?? "");
        const output = nonce ? parseMarkerReviewText(meta.text, nonce) : null;
        if (!output) throw new Error("OpenCode did not return valid review findings.");

        // Derive the verdict from finding severities (like Claude) rather than
        // trusting the model's free-form `correctness` string. Marker engines
        // have no schema flag, so a model value like "not correct" would be
        // stored verbatim and the detail panel (any string containing "correct"
        // except "incorrect" → green) would invert the displayed result.
        const hasImportant = output.findings.some((f) => f.severity === "important");
        job.summary = {
          correctness: hasImportant ? "Issues Found" : "Correct",
          explanation: output.summary.explanation,
          confidence: output.summary.confidence,
        };

        // Reuse the shared ingest() decoration (PR context, diff scope, profile
        // label); marker engines add a fail-closed check on the returned result.
        const result = ingest(
          transformMarkerFindings(
            output.findings,
            job.source,
            "OpenCode",
            cwd,
            workspace ? (filePath) => workspace.normalizeAnnotationPath(filePath) : undefined,
          ),
          "opencode-review",
        );
        if (result && "error" in result) {
          throw new Error(`OpenCode annotation insertion failed: ${result.error}`);
        }
        return;
      }

      // --- Guide path ---
      if (job.provider === "guide") {
        // Validate refs against the LAUNCH-time changed-file set (snapshotted
        // on the job at buildCommand time), not the current patch — the model
        // planned section placement against that exact file set, and the
        // client already degrades stale refs per-file if the reviewer has
        // since switched diff/base/PR. Re-deriving from the current patch
        // here would spuriously invalidate every ref in an otherwise-valid
        // guide the moment the view changes mid-generation. Falls back to the
        // current patch only if the snapshot is missing (defensive; should
        // not happen in practice — see agent-jobs.ts's changedFilesSnapshot).
        const changedFiles = meta.changedFilesSnapshot ?? listPatchFiles(currentPatch).map((f) => f.path);
        const { summary, error } = await guide.onJobComplete({ job, meta, changedFiles, launchReview: meta.launchReview });
        if (summary) {
          job.summary = summary;
          // Autosave (#1112): only guides that passed validateGuideOutput ever
          // reach guideResults, so a getGuide hit here IS the validation gate.
          // Failed/invalid guides never write. The job's launch-time context
          // snapshot labels the envelope — never the live session state, which
          // may have PR/diff-switched while the job ran. The launch-time review
          // (the diff the guide describes) is stored beside it for export.
          const validated = guide.getGuide(job.id);
          if (validated) await guideStore.saveForJob(guideSaveJob(job), validated, job.guideContext, meta.launchReview);
        } else {
          // Fail closed: an exit-0 job with empty,
          // malformed, or fully-invalidated output must not look like a
          // successful card that 404s on /api/guide/:id.
          job.status = "failed";
          job.error = error ?? GUIDE_EMPTY_OUTPUT_ERROR;
        }
        return;
      }
    },
  });

  const isRemote = isRemoteSession();
  // Hover cards for issue, PR and MR links (ref-cards.ts): nothing runs until a card is asked for, and
  // never in remote mode. In a `--tailscale` session only this machine's tabs and the tailnet owner's get
  // them (`refCardsTailnetAllowed`): other devices must not drive the user's gh / glab.
  // The app page is served compressed only to sessions reachable from another
  // device: remote mode or --tailscale (#1617). Local sessions are unchanged.
  const compressAppHtml = isRemote;
  const app = openPackedApp(htmlContent, { page: (html) => customThemesPage(html) });
  // Hashed off the request path, so `/api/diff` finds it ready.
  const diagramEngineAssets = createDiagramEngineAssets(options.diagramEngine);
  diagramEngineAssets.warm();
  const semDiffAssets = createSemDiffAssets(options.semDiff);
  semDiffAssets.warm();

  // Detect repo info (cached for this session)
  // In PR mode, derive from metadata instead of local git
  // Static patch: the session has no repository. Whatever repo the process
  // happens to sit in is NOT the patch's origin, and advertising it would put
  // an unrelated repo and branch in the review header.
  let repoInfo = isStaticPatchMode
    ? undefined
    : workspace
      ? { display: basename(workspace.root), branch: "Workspace" }
    : await getRepoInfo(gitContext?.cwd);
  if (!isStaticPatchMode && gitContext?.repository?.displayFallback) {
    repoInfo = {
      ...repoInfo,
      display: repoInfo?.display || gitContext.repository.displayFallback,
    };
  }


  // Decision promise
  let reviewDecided = false;
  let resolveDecision: (result: {
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    /** The host closed the session (`POST /api/host/close`): an `exit` that keeps the draft. */
    closedBy?: "agent";
    /** With `closedBy`: the reviewer's unsent comments kept in the draft. */
    unsentAnnotations?: number;
    /** The review was posted to the PR platform (`POST /api/pr-action`); `feedback` is only its status line. */
    platform?: true;
    /**
     * What the decision is about, as the server shows it NOW: the active PR's
     * URL (after any in-place `/api/pr-switch`), the workspace root, or the
     * working tree the active diff reads (a worktree diff type moves it).
     * Absent for a static patch (the caller knows the file).
     */
    target?: string;
  }) => void;
  const decisionPromise = new Promise<{
    approved: boolean;
    feedback: string;
    reviewDirectory?: string;
    annotations: unknown[];
    agentSwitch?: string;
    exit?: boolean;
    /** The host closed the session (`POST /api/host/close`): an `exit` that keeps the draft. */
    closedBy?: "agent";
    /** With `closedBy`: the reviewer's unsent comments kept in the draft. */
    unsentAnnotations?: number;
    /** The review was posted to the PR platform (`POST /api/pr-action`); `feedback` is only its status line. */
    platform?: true;
    /**
     * What the decision is about, as the server shows it NOW: the active PR's
     * URL (after any in-place `/api/pr-switch`), the workspace root, or the
     * working tree the active diff reads (a worktree diff type moves it).
     * Absent for a static patch (the caller knows the file).
     */
    target?: string;
  }>((resolve) => {
    resolveDecision = (result) => {
      reviewDecided = true;
      const target = result.target ?? activeReviewTarget();
      resolve(target ? { ...result, target } : result);
    };
  });

  const reviewAlreadyDecided = () =>
    Response.json({ error: "This review session has already been decided.", code: "already_decided" }, { status: 409 });


  /**
   * Both sides of one path for the current diff, read the way the diff was
   * made (workspace, full-stack PR checkout, local VCS, or the PR platform).
   * Shared by /api/file-content and the package changes route.
   */
  const readDiffFileContents = async (
    filePath: string,
    oldPath: string | undefined,
    requestedBase: string | undefined,
  ): Promise<{ oldContent: string | null; newContent: string | null } | { error: string }> => {
    if (isBinaryPatchFile(currentPatch, filePath)) {
      return { oldContent: null, newContent: null };
    }

    if (workspace) {
      try {
        return await workspace.getFileContents(filePath, oldPath);
      } catch (error) {
        return { error: error instanceof Error ? error.message : "No file access available" };
      }
    }


    // Local review: read file contents from local git
    if (hasLocalAccess) {
      const base = resolveReviewBase(requestedBase);
      const defaultCwd = gitContext?.cwd;
      return getVcsFileContentsForDiff(
        currentDiffType as DiffType,
        base,
        filePath,
        oldPath,
        defaultCwd,
      );
    }

    // The diff is computed against the merge-base (common ancestor), not the
    // base branch tip. File contents must match the diff for hunk expansion.

    return { error: "No file access available" };
  };

  // Where the current mode reads one side of a repository path, as
  // bytes: shared by /api/review-image (#1598) and the Markdown
  // preview's /api/review-markdown-image, in the same priority order
  // as /api/file-content below.
  const readReviewSide = async (
    side: DiffSide,
    filePath: string,
    oldPath: string | undefined,
    maxBytes: number,
    signal?: AbortSignal,
    requestedBase?: string,
  ): Promise<FileBytesRead> => {
    if (workspace) return workspace.getFileBytes(filePath, oldPath, side, maxBytes);
    if (hasLocalAccess) {
      return getVcsFileBytesForDiff(
        currentDiffType as DiffType,
        requestedBase !== undefined ? resolveReviewBase(requestedBase) : currentBase,
        filePath,
        oldPath,
        side,
        maxBytes,
        gitContext?.cwd,
      );
    }
    return { kind: "unavailable" };
  };
  const imageSizesAdvert = (patch: string) =>
    reviewImageSizesAdvert({
      available: imagePreviewSupported,
      patch,
      readSide: (side, filePath, oldPath, maxBytes, signal) => runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
    });

  // Package changes under package.json and lockfile diffs. The server reads
  // the files and works out every name a lookup would send; the lookup itself
  // runs only when config.json allows it (see package-changes-service.ts).
  let packageRepoRoot: { cwd: string | undefined; root: Promise<string | null> } | null = null;
  const packageChanges = createPackageChangesService({
    snapshotId: () => currentSnapshotId(),
    diffFiles: () => parseDiffToFiles(currentPatch),
    readSide: async (side, path, oldPath, base) => {
      try { validateFilePath(path); if (oldPath) validateFilePath(oldPath); } catch { return { kind: "unreadable", reason: "invalid path" }; }
      const read = await readReviewSide(side, path, oldPath, MAX_PACKAGE_FILE_BYTES, undefined, base);
      if (read.kind === "ok") return { kind: "ok", text: new TextDecoder().decode(read.bytes) };
      if (read.kind === "missing") return { kind: "missing" };
      if (read.kind === "too-large") return { kind: "unreadable", reason: "too large" };
      // No byte reader for this mode: the text reader, whose null cannot tell
      // absent from unreadable, so it counts as unreadable.
      const text = await readDiffFileContents(path, oldPath, base);
      const value = "error" in text ? null : side === "old" ? text.oldContent : text.newContent;
      return value == null ? { kind: "unreadable", reason: "could not be read" } : { kind: "ok", text: value };
    },
    settings: () => {
      if (workspace) {
        const session = workspace;
        return {
          kind: "local",
          dirOf: async (path) => {
            const target = resolveWorkspaceFilePath(session.repos, path);
            return target ? dirname(join(target.repo.cwd, target.repoRelativePath)) : null;
          },
        };
      }
      if (!hasLocalAccess || isStaticPatchMode) return { kind: "none" };
      return {
        kind: "local",
        dirOf: async (path) => {
          // Patch paths are relative to the repository top level of the
          // directory the diff ran in (a worktree mode runs elsewhere).
          const cwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd) ?? gitContext?.cwd;
          if (!packageRepoRoot || packageRepoRoot.cwd !== cwd) {
            const known = cwd === gitContext?.cwd ? gitContext?.root : undefined;
            packageRepoRoot = {
              cwd,
              root: known
                ? Promise.resolve(known)
                : gitRuntime.runGit(["rev-parse", "--show-toplevel"], { cwd })
                  .then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null))
                  .catch(() => null),
            };
          }
          const root = await packageRepoRoot.root;
          return root ? dirname(join(root, path)) : null;
        },
      };
    },
    homeDir: () => {
      try { return homedir(); } catch { return null; }
    },
    prepare: async () => ({ final: true }),
    lookupEnabled: () => resolvePackageLookup(loadConfig()),
    env: process.env,
  });

  const requestHostGuard = createRequestHostGuard();
  const server = await startBunServerOnAvailablePort((port) =>
    Bun.serve(withPlannotatorServerHeader({
        hostname: getServerHostname(),
        port,
        // Bun's default 10s idleTimeout kills requests that legitimately park:
        // PR-mode endpoints await the background checkout warmup (a clone that
        // can take minutes) and AI SSE streams can stall between bytes.
        idleTimeout: 0,

        async fetch(req, server) {
          // Who sent it (an SSH session answers its own tunnel as local: this-machine.ts).
          notePeer(req, server);
          // Host allowlist first, before any route (request-host-guard.ts).
          const hostRefusal = requestHostGuard.check(req);
          if (hostRefusal) return hostRefusal;
          // Then no write from another site, before any route (request-origin-guard.ts).
          const originRefusal = refuseCrossOriginWrite(req);
          if (originRefusal) return originRefusal;

          const url = new URL(req.url);
          if (url.pathname.startsWith("/api/pr-") || url.pathname === "/api/fetch-base") {
            return handleApiNotFound(url.pathname);
          }


          // API: Get guide result — live job ids, or `saved:{id}` for a
          // persisted guide loaded from the on-disk store (#1112).
          if (url.pathname.match(/^\/api\/guide\/[^/]+$/) && req.method === "GET") {
            const jobId = decodePathSegment(url.pathname.slice("/api/guide/".length));
            if (jobId === null) return Response.json({ error: MALFORMED_PATH_ERROR }, { status: 400 });
            if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
              const saved = await guideStore.getSavedGuideData(jobId.slice(SAVED_GUIDE_ID_PREFIX.length));
              if (!saved) return Response.json({ error: "Guide not found" }, { status: 404 });
              return Response.json(saved);
            }
            const result = guide.getGuide(jobId);
            if (!result) return Response.json({ error: "Guide not found" }, { status: 404 });
            return Response.json({ ...result, ...(guideStore.isJobSaved(jobId) ? { saved: true } : {}) });
          }

          // API: Save guide reviewed state. Live job ids also write through to
          // the job's autosaved file; `saved:{id}` ids persist directly.
          const reviewedMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/reviewed$/);
          if (reviewedMatch && req.method === "PUT") {
            const jobId = decodePathSegment(reviewedMatch[1]);
            if (jobId === null) return Response.json({ error: MALFORMED_PATH_ERROR }, { status: 400 });
            try {
              const body = await req.json() as { reviewed: boolean[] };
              if (Array.isArray(body.reviewed)) {
                if (jobId.startsWith(SAVED_GUIDE_ID_PREFIX)) {
                  const ok = await guideStore.updateSavedReviewed(jobId.slice(SAVED_GUIDE_ID_PREFIX.length), body.reviewed);
                  if (!ok) return Response.json({ error: "Guide not found" }, { status: 404 });
                } else {
                  guide.saveReviewed(jobId, body.reviewed);
                  await guideStore.writeThroughReviewed(jobId, body.reviewed);
                }
              }
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          // API: Portable export of a guide (decision record D1/D9). Resolves
          // `saved:{id}` from the store and live ids from this session's
          // launch review (persisted copy as fallback). No size gate: the file
          // is as big as the diff, and that is the user's call.
          const guideExportMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/(export|export-info)$/);
          if (guideExportMatch && req.method === "GET") {
            const jobId = decodePathSegment(guideExportMatch[1]);
            if (jobId === null) return Response.json({ error: MALFORMED_PATH_ERROR }, { status: 400 });
            const snapshot = await resolveGuideSnapshotForExport(jobId);
            if (!snapshot) {
              return Response.json({ error: "This guide cannot be exported: its diff was not retained." }, { status: 404 });
            }
            const viewer = resolveGuideViewerAssets(GUIDE_VIEWER_MANIFEST, { baseUrl: process.env.PLANNOTATOR_GUIDE_VIEWER_URL });
            const html = createGuideHtml(snapshot, { viewer });
            const filename = guideExportFilename(snapshot.guide.title);
            if (guideExportMatch[2] === "export-info") {
              return Response.json({
                bytes: new TextEncoder().encode(html).byteLength,
                filename,
                languages: detectGuideLanguages(snapshot.review.rawPatch),
              });
            }
            return new Response(html, {
              status: 200,
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Cache-Control": "no-store",
              },
            });
          }

          // API: List saved guides for the current repo (#1112)
          if (url.pathname === "/api/guides" && req.method === "GET") {
            return Response.json(await guideStore.listSaved());
          }

          // API: Delete a saved guide.
          const savedGuideDeleteMatch = url.pathname.match(/^\/api\/guides\/([^/]+)$/);
          if (savedGuideDeleteMatch && req.method === "DELETE") {
            const savedId = decodePathSegment(savedGuideDeleteMatch[1]);
            if (savedId === null) return Response.json({ error: MALFORMED_PATH_ERROR }, { status: 400 });
            const ok = await guideStore.deleteSaved(savedId);
            if (!ok) return Response.json({ error: "Guide not found" }, { status: 404 });
            return Response.json({ ok: true });
          }

          if (savedGuideDeleteMatch && req.method === "PATCH") {
            const savedId = decodeURIComponent(savedGuideDeleteMatch[1]);
            let body: { title?: unknown };
            try {
              body = (await req.json()) as { title?: unknown };
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
            if (!normalizeGuideTitle(body?.title)) return Response.json({ error: "A title is 1 to 200 characters." }, { status: 400 });
            const ok = await guideStore.renameSaved(savedId, body.title as string);
            if (!ok) return Response.json({ error: "Guide not found" }, { status: 404 });
            return Response.json({ ok: true });
          }

          // API: Get a failed guide job's captured raw output for manual repair
          const guideOutputMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/output$/);
          if (guideOutputMatch && req.method === "GET") {
            const jobId = guideOutputMatch[1];
            const payload = guide.getFailedPayload(jobId);
            if (payload === null) return Response.json({ error: "No captured output" }, { status: 404 });
            return Response.json({ payload });
          }

          // API: Manually submit corrected guide JSON for a failed job
          const guideSubmitMatch = url.pathname.match(/^\/api\/guide\/([^/]+)\/submit$/);
          if (guideSubmitMatch && req.method === "POST") {
            const jobId = guideSubmitMatch[1];
            const existingJob = agentJobs.getJob(jobId);
            if (!existingJob) return Response.json({ error: "Job not found" }, { status: 404 });
            if (existingJob.status !== "failed" && existingJob.status !== "killed") {
              return Response.json({ error: "This job already has a guide" }, { status: 409 });
            }
            try {
              const body = await req.json() as { payload?: string };
              const payload = typeof body.payload === "string" ? body.payload : "";
              // Fallback only — submitManualOutput prefers the job's own
              // launch-time changed-file set (guide.launchChangedFiles,
              // recorded by onJobComplete) over this current-patch derivation.
              const changedFiles = listPatchFiles(currentPatch).map((f) => f.path);
              const result = guide.submitManualOutput(jobId, payload, changedFiles);
              if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
              const { sections, files } = result;
              agentJobs.completeJobExternally(jobId, {
                correctness: "Guide Generated",
                explanation: `${sections} section${sections !== 1 ? "s" : ""}, ${files} file${files !== 1 ? "s" : ""} placed (manually repaired)`,
                confidence: 1,
              });
              // A manually repaired guide passed the same validateGuideOutput
              // gate as an automatic one — persist it too (#1112), labeled
              // with the job's own launch-time context snapshot.
              const repaired = guide.getGuide(jobId);
              if (repaired) await guideStore.saveForJob(guideSaveJob(existingJob), repaired, existingJob.guideContext, guide.getLaunchReview(jobId) ?? undefined);
              return Response.json({ ok: true, sections, files });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
          }

          // API: Get diff content
          if (url.pathname === "/api/diff" && req.method === "GET") {
            // Snapshot the served state BEFORE the sidecar await: the startup
            // base upgrade can land mid-await, and reading the globals after
            // it would pair a rebuilt patch with sections computed from the
            // old base — a misgrouped panel. snapshotId travels with the
            // patch it identifies: a mid-await upgrade bumps draftKey, and
            // this client's next freshness probe (echoing the OLD id) raises
            // the Refresh banner for the consistent old snapshot served here.
            const servedPatch = currentPatch;
            const servedBase = currentBase;
            const servedGitRef = currentGitRef;
            const servedError = currentError;
            const servedDiffType = currentDiffType;
            const servedHideWhitespace = currentHideWhitespace;
            const servedSnapshotId = currentSnapshotId();
            const servedGitContext = clientGitContext;
            const servedDraftTarget = localDraftTarget;
            const sections = await buildSectionsSidecar(servedBase, servedDiffType as string);
            const commitInfo = await buildCommitInfoSidecar(servedDiffType as string);
            const generatedFiles = await buildGeneratedFilesSidecar(servedPatch, servedDiffType as string);
            return Response.json({
              rawPatch: servedPatch,
              aiReviewContext: buildCurrentAiReviewContext(servedPatch),
              aiEnabled: !!openCode,
              gitRef: servedGitRef,
              snapshotId: servedSnapshotId,
              localDraftTarget: servedDraftTarget,
              origin,
              mode: isWorkspaceMode ? "workspace" : undefined,
              diffType: hasLocalAccess || isWorkspaceMode || isStaticPatchMode ? servedDiffType : undefined,
              // Echo the active base so a page refresh or reconnect rehydrates
              // the picker to what the server is actually using — not the
              // detected default.
              base: hasLocalAccess ? servedBase : undefined,
              hideWhitespace: servedHideWhitespace,
              ...(workspace && { diffOptions: workspace.diffOptions }),
              gitContext: hasLocalAccess ? servedGitContext : undefined,
              sharingEnabled,
              approvalNotesSupported,

              serverSession,
              imagePreviewSupported,
              ...(await imageSizesAdvert(servedPatch)),
              markdownPreviewSupported,
              repoFilesSupported,
              // Session-constant, read once by the page at mount.
              diagramEngine: await diagramEngineAssets.advert(),
              semDiff: await semDiffAssets.advert(),
              ...sourceKindAdvert,
              // Mount is the only place the pin matters, so it rides /api/diff
              // alone (not the switch endpoints).
              ...(options.openStatePinned && { openStatePinned: true }),
              // `--title` (#2289): session-constant, read by the page at mount.
              ...(options.title && { title: options.title }),
              shareBaseUrl,
              repoInfo,
              // config.json `markdownExtensions`: extra extensions the review
              // UI's Markdown preview treats as Markdown.
              markdownExtensions: getExtraMarkdownExtensions(),
              // PR mode advertises the ready PR checkout (null while warming), so
              // the Open-in button gates correctly from the initial load — not
              // the launch repo. Non-PR keeps the workspace/local cwd.
              ...(workspace
                  ? { agentCwd: workspace.root }
                  : options.agentCwd
                    ? { agentCwd: options.agentCwd }
                    : {}),
              ...(sections && { sections }),
              ...(commitInfo && { commitInfo }),
              ...(generatedFiles && { generatedFiles }),
              ...(servedError && { error: servedError }),
              callFlow: await getCallFlowAdvert(servedDiffType as DiffType),
              serverConfig: getServerConfig(undefined, { cookieHost: !isRemote, hideAgentSettings: true }),
            });
          }

          // API: List apps the host can open a file in (Open in App control).
          if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
            // Static patch mode has no tree the patch's paths belong to, so
            // advertise no apps: the client hides the control rather than
            // offering to open a same-named file from an unrelated checkout.
            if (isStaticPatchMode) return Response.json({ available: false, apps: [] });
            return handleOpenInApps();
          }

          // API: Open a file in an app. Resolves the repo-relative `git diff`
          // path against the VCS root server-side (resolveAgentCwd folds in
          // workspace.root, the PR local checkout, resolveVcsCwd(gitContext.cwd),
          // and process.cwd()) — not the client `base`, which is wrong when
          // review runs from a subdirectory — then containment-checks it.
          if (url.pathname === "/api/open-in" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Open in app is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            // A static patch's paths are relative to whatever tree produced
            // the patch, which this process cannot know — resolving them
            // against process.cwd() would open an unrelated file with the
            // same name. Refuse instead of guessing.
            if (isStaticPatchMode) {
              return Response.json(
                { error: "Open in app is unavailable for a static patch review" },
                { status: 400 },
              );
            }
            return handleOpenIn(req, { resolveRoot: resolveOpenInRoot, serverSession });
          }

          // API: cheap staleness probe — has the underlying VCS state changed
          // since the current diff snapshot was computed? Best-effort: anything
          // that cannot be fingerprinted reports fresh (no banner).
          if (url.pathname === "/api/diff/fresh" && req.method === "GET") {
            // In PR review the local checkout can appear (pool warmup) or change
            // (in-place PR switch) after the initial /api/diff, so re-advertise it
            // on every probe — the Open-in control tracks the current checkout
            // without a page reload. resolvePRLocalCwd() is null until a usable
            // checkout exists. Non-PR sessions never carry this field.
            const baseline = currentFingerprint;
            // Carry baseBehindRemote on EVERY response — the client sets the flag
            // unconditionally on each probe, so omitting it here clears the
            // "behind GitHub" banner for that poll (a flicker) until the next one.
            // Per-CLIENT staleness: the client echoes the snapshotId it is
            // rendering; a mismatch means the SERVER's snapshot moved under it
            // (startup base upgrade, a switch from another tab, an in-place PR
            // switch) regardless of what the VCS fingerprint says. This is what
            // lets one server serve multiple tabs holding different snapshots
            // without lying to any of them. The "snapshot:" fingerprint keys
            // the client's dismissal to the server snapshot that made it stale.
            const clientSnapshot = url.searchParams.get("snapshot");
            const serverSnapshot = currentSnapshotId();
            if (clientSnapshot && clientSnapshot !== serverSnapshot) {
              return Response.json({
                fresh: false,
                fingerprint: `snapshot:${serverSnapshot}`,
              });
            }
            const probe = await computeDiffFingerprint();
            // A diff switch landing mid-probe replaces the snapshot (and its
            // fingerprint); report fresh and let the next poll compare
            // against the new baseline.
            const fresh = probe == null || probe === baseline;
            // Deliberately NO maybeRefreshRemoteBaseInfo() here (#1553). This
            // endpoint is polled every 5s for as long as the page is open, so
            // hanging the 60s remote probe off it made an idle review contact
            // the remote once a minute forever — one hardware-key touch prompt
            // per minute on a smartcard-backed SSH setup, with no visible UI
            // activity. The remote is now queried on the interactions that can
            // actually change the answer: startup, /api/diff, /api/diff/switch
            // (which backs the Refresh button and the base/diff pickers), and
            // the explicit Fetch. `baseBehindRemote` still rides every
            // response below, from the cached value, so the banner neither
            // flickers nor disappears between refreshes.
            // The probe fingerprint lets the client distinguish "still the
            // same staleness I dismissed" from "ANOTHER change landed since".
            return Response.json({
              fresh,
              ...(fresh ? {} : { fingerprint: probe }),
            });
          }

          // API: fetch the remote default branch so the local baseline catches
          // up with GitHub. Client re-runs /api/diff/switch afterwards.


          // API: Snapshot-bound call-stack impact analysis.
          if (url.pathname === "/api/call-flow" && req.method === "GET") {
            // A hard VCS failure before analyze() (e.g. patch materialization
            // hitting an unreadable file) must still produce the JSON error
            // envelope the client's quiet-failure UX parses, never a bare 500.
            let result: CallFlowResponse;
            try {
              result = await getCallFlow(url);
            } catch (error) {
              result = {
                status: "error",
                reason: "analysis-failed",
                message: error instanceof Error ? error.message : String(error),
              };
            }
            return Response.json(result, {
              status: result.status === "stale" ? 409 : 200,
              headers: { "Cache-Control": "no-store" },
            });
          }

          // API: Opt-in CallDiff runtime install. Single-flighted: concurrent
          // POSTs join the in-flight install. Node preflight runs before any
          // download, and a cross-origin POST is rejected because this
          // endpoint starts a native runtime download and build.
          if (url.pathname === "/api/call-flow/install" && req.method === "POST") {
            if (!callFlowInstallOriginAllowed(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin install requests are not allowed" }, { status: 403 });
            }
            let request: ReturnType<typeof parseCallFlowInstallRequest>;
            try {
              request = parseCallFlowInstallRequest(await req.json());
            } catch {
              request = null;
            }
            if (!request) return Response.json({ error: "Invalid call-flow install request" }, { status: 400 });
            const advert = await getCallFlowAdvert(currentDiffType as DiffType, true);
            const languageIds = resolveCallFlowInstallTargets(
              request.languageIds,
              advert.installPlan?.languageIds,
              advert.available,
            );
            if (!advert.installable || languageIds.length === 0) {
              return Response.json({ error: advert.message ?? "No call-flow language support needs installation." }, { status: 409 });
            }
            const status = await callFlowInstall.start(languageIds);
            return Response.json(status, { headers: { "Cache-Control": "no-store" } });
          }

          // API: Poll the in-app runtime install. done persists until the
          // runtime advert resolves available; error persists until the next
          // install POST retries.
          if (url.pathname === "/api/call-flow/install-status" && req.method === "GET") {
            return Response.json(callFlowInstall.getStatus(), { headers: { "Cache-Control": "no-store" } });
          }

          // Read-only capability refresh. It deliberately does not share the
          // settings mutation epoch, so install completion cannot supersede a
          // concurrent toggle write.
          if (url.pathname === "/api/review-analysis" && req.method === "GET") {
            if (reviewAnalysisMutationEpoch !== null) {
              return Response.json({ superseded: true }, { headers: { "Cache-Control": "no-store" } });
            }
            const analysisEpoch = reviewAnalysisEpoch;
            const viewEpoch = diffSwitchEpoch;
            const callFlow = await getCallFlowAdvert();
            if (
              analysisEpoch !== reviewAnalysisEpoch
              || reviewAnalysisMutationEpoch !== null
              || viewEpoch !== diffSwitchEpoch
            ) {
              return Response.json({ superseded: true });
            }
            return Response.json({ callFlow }, { headers: { "Cache-Control": "no-store" } });
          }

          // API: Persist analysis toggles and immediately re-advertise both
          // independent capabilities. This makes enabling a layer live in the
          // current review instead of requiring a reload.
          if (url.pathname === "/api/review-analysis" && req.method === "POST") {
            const analysisEpoch = ++reviewAnalysisEpoch;
            reviewAnalysisMutationEpoch = analysisEpoch;
            const viewEpoch = diffSwitchEpoch;
            try {
              const reviewAnalysis = parseReviewAnalysisConfig(await req.json());
              if (!reviewAnalysis) {
                return Response.json({ error: "Invalid analysis settings" }, { status: 400 });
              }
              if (analysisEpoch !== reviewAnalysisEpoch) {
                return Response.json({ superseded: true });
              }
              const nextCallFlowEnabled = reviewAnalysis.callFlow ?? callFlowEnabled();
              const callFlow = await getCallFlowAdvert(currentDiffType as DiffType, nextCallFlowEnabled);
              if (
                analysisEpoch !== reviewAnalysisEpoch
                || viewEpoch !== diffSwitchEpoch
              ) {
                return Response.json({ superseded: true });
              }
              if (!saveConfig({ reviewAnalysis })) return Response.json({ error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, { status: 500 });
              if (!nextCallFlowEnabled) callFlowService.cancelAll();
              return Response.json({ callFlow });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            } finally {
              // A read-only advert refresh that began during this mutation
              // must not publish capabilities computed from the old config
              // after the mutation response. The second transition marks the
              // write as settled without allowing GET to supersede it.
              if (reviewAnalysisEpoch === analysisEpoch) reviewAnalysisEpoch++;
              if (reviewAnalysisMutationEpoch === analysisEpoch) reviewAnalysisMutationEpoch = null;
            }
          }

          // API: Linear commit history for the Commits panel. Local Git only
          // (same gate the client's commitsCapable applies). Computed against
          // the same cwd as the active diff so worktree sessions list the
          // worktree's history, and against the active base so the divider
          // matches the review baseline.
          if (url.pathname === "/api/commits" && req.method === "GET") {
            const commitsVcs = sessionVcsType ?? "git";
            if (!gitContext || workspace || commitsVcs !== "git") {
              return Response.json(
                { error: "Commit history is only available for local Git reviews" },
                { status: 400 },
              );
            }
            const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
            const before = url.searchParams.get("before") ?? undefined;
            const commitsCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext.cwd);
            const pageOptions = {
              ...(Number.isFinite(limitParam) && { limit: limitParam }),
              ...(before !== undefined && { before }),
            };
            let page;
            try {
              page = await listCommitHistory(gitRuntime, currentBase, commitsCwd, pageOptions);
            } catch (err) {
              return Response.json(
                { error: err instanceof Error ? err.message : "Could not read commit history" },
                { status: 500 },
              );
            }
            if (!page) {
              return Response.json({ error: "Could not read commit history" }, { status: 500 });
            }
            return Response.json(page);
          }

          // API: Switch diff type (requires local file access)
          if (url.pathname === "/api/diff/switch" && req.method === "POST") {
            // Capture the ordering token BEFORE any await. Body delivery can
            // finish out of arrival order under network jitter, so capturing the
            // epoch after `await req.json()` let a slow-body OLDER request bump
            // last and overwrite a newer, already-confirmed switch.
            const switchEpoch = ++diffSwitchEpoch;
            // The remote probe moved here from the 5s freshness poll (#1553).
            // This endpoint backs the diff-type and base pickers AND the
            // "Diff out of date · Refresh" button, so it fires exactly when the
            // reviewer asks for a fresh answer rather than on a timer. Kicked
            // off fire-and-forget: a hanging remote must never make a diff
            // switch wait on the network, so this response still reports the
            // cached staleness and the next one carries the refreshed value.
            if (!hasLocalAccess && !workspace) {
              return Response.json(
                { error: "Not available without local file access" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { diffType: DiffType | WorkspaceDiffType; base?: string; hideWhitespace?: boolean; explicitBase?: boolean };
              let newDiffType = body.diffType;

              if (typeof newDiffType !== "string" || !newDiffType) {
                return Response.json(
                  { error: "Missing diffType" },
                  { status: 400 }
                );
              }

              // Don't commit hideWhitespace to shared state yet — a request that
              // ends up superseded must not leave its value behind. Compute the
              // diff with a local, then commit only if we win the epoch check.
              const effectiveHideWhitespace = typeof body.hideWhitespace === "boolean"
                ? body.hideWhitespace
                : currentHideWhitespace;

              if (workspace) {
                const snapshot = await workspace.rebuild({
                  diffType: newDiffType,
                  hideWhitespace: effectiveHideWhitespace,
                });
                if (switchEpoch !== diffSwitchEpoch) {
                  return Response.json({ superseded: true });
                }
                currentHideWhitespace = effectiveHideWhitespace;
                currentPatch = snapshot.rawPatch;
                currentFileIdentities = undefined;
                currentGitRef = snapshot.gitRef;
                currentDiffType = workspace.diffType;
                currentError = snapshot.error;
                draftKey = contentHash(currentPatch);
                captureDiffFingerprint();

                return Response.json({
                  rawPatch: currentPatch,
                  // Snapshot arg: robust against a future await sneaking in
                  // between the epoch check and this response.
                  aiReviewContext: buildCurrentAiReviewContext(snapshot.rawPatch),
                  gitRef: currentGitRef,
                  snapshotId: currentSnapshotId(),
                  approvalNotesSupported,

                  serverSession,
                  imagePreviewSupported,
                  ...(await imageSizesAdvert(currentPatch)),
                  markdownPreviewSupported,
                  repoFilesSupported,
                  ...sourceKindAdvert,
                  diffType: currentDiffType,
                  diffOptions: workspace.diffOptions,
                  hideWhitespace: currentHideWhitespace,
                  ...(currentError && { error: currentError }),
                  callFlow: await getCallFlowAdvert(),
                });
              }

              if (sessionVcsType && !vcsOwnsDiffType(sessionVcsType, newDiffType as string)) {
                return Response.json(
                  { error: `Diff type is not available in this ${sessionVcsType} session` },
                  { status: 400 },
                );
              }

              // Guard against non-string payloads — resolveBaseBranch calls
              // string methods and would throw a TypeError otherwise. Mirrors
              // Pi's guard so both runtimes validate identically.
              const requestedBase = typeof body.base === "string" ? body.base : undefined;
              // An explicit pick from the base picker is honored verbatim —
              // the local/remote groups are distinct choices, so "main" must
              // not be canonicalized to "origin/main" when the user chose the
              // local ref on purpose. Sticky: later echoes of that choice
              // (diff-type switches, refreshes) must not re-canonicalize it.
              const nextBaseExplicitlyChosen = baseExplicitlyChosen ||
                (body.explicitBase === true && !!requestedBase);
              const requestedDiffType = newDiffType as DiffType;
              const availability = clientGitContext
                ? resolveAvailableDiffType(clientGitContext, requestedDiffType, nextBaseExplicitlyChosen)
                : { diffType: requestedDiffType };
              newDiffType = availability.diffType;
              const base = resolveReviewBase(
                requestedBase,
                nextBaseExplicitlyChosen,
                currentBase,
              );
              const defaultCwd = gitContext?.cwd;

              // Run the new diff
              const result = await runVcsDiff(newDiffType as DiffType, base, defaultCwd, {
                hideWhitespace: effectiveHideWhitespace,
                captureFileIdentities: sessionVcsType === "git",
              });
              const resultContext = sessionVcsType === "gitbutler" && result.gitContext?.vcsType === "gitbutler"
                ? result.gitContext
                : undefined;
              const resultBase = resultContext?.defaultBranch ?? base;

              // A newer switch started while we computed — abandon before
              // touching shared state so we never clobber the latest request.
              if (switchEpoch !== diffSwitchEpoch) {
                return Response.json({ superseded: true });
              }

              // Stage every field locally. No shared review state is written
              // until the final epoch guard, so a newer invalid request cannot
              // strand a patch/fingerprint from this request beside the prior
              // GitButler context revision.
              const previousDiffType = currentDiffType;

              // Recompute gitContext for the effective cwd so the client's
              // sidebar (current branch, default branch, diff-mode options)
              // reflects the worktree we're now reviewing — not the main
              // repo's startup state. Best-effort: on failure the client
              // keeps its existing context.
              //
              // Skipped for same-cwd commit:<sha> switches — the commit-rail
              // hot path (three git enumerations dominated click latency; a
              // historical commit's diff can't change any of it). The client
              // keeps its existing context when the field is absent.
              let updatedContext = resultContext;
              let updatedContextRevision = resultContext
                ? getGitButlerContextRevision(resultContext) ?? ""
                : undefined;
              if (!updatedContext && gitContext && !isSameCwdCommitSwitch(previousDiffType as string, newDiffType as string)) {
                try {
                  const effectiveCwd = resolveVcsCwd(newDiffType as DiffType, gitContext.cwd);
                  updatedContext = await getVcsContext(effectiveCwd, sessionVcsType);
                  updatedContextRevision = getGitButlerContextRevision(updatedContext) ?? "";
                } catch {
                  /* best-effort */
                }
              }

              // Base may have changed — re-evaluate behind-ness from the
              // cached remote tip (cheap, local-only).
              // Await (not fire-and-forget) so the switch response carries the
              // freshly-recomputed baseBehindRemote — otherwise the banner lags a
              // poll cycle switching INTO a base-relative mode, or lingers stale
              // switching AWAY from one. Local rev-parse only; cheap.
              const nextBase = updatedContext && sessionVcsType === "gitbutler"
                ? updatedContext.defaultBranch
                : resultBase;
              const sections = await buildSectionsSidecar(nextBase, newDiffType as string);
              const commitInfo = await buildCommitInfoSidecar(newDiffType as string);
              const generatedFiles = await buildGeneratedFilesSidecar(result.patch, newDiffType as string);
              const [switchCallFlow, nextDraftTarget] = await Promise.all([
                getCallFlowAdvert(newDiffType as DiffType),
                localGitDraftTargetKey({
                  diffType: newDiffType, base: nextBase, cwd: gitContext?.cwd ?? process.cwd(),
                  defaultBase: undefined,
                  vcsType: sessionVcsType,
                }, gitRuntime.runGit),
              ]);
              // Final guard: if a newer switch took over during the trailing
              // awaits, don't emit — the client would misapply our stale body
              // over the newer one (which has its own response inbound).
              if (switchEpoch !== diffSwitchEpoch) {
                return Response.json({ superseded: true });
              }
              currentHideWhitespace = effectiveHideWhitespace;
              currentPatch = result.patch;
              currentFileIdentities = result.fileIdentities;
              currentGitRef = result.label;
              currentDiffType = newDiffType;
              currentBase = nextBase;
              baseExplicitlyChosen = nextBaseExplicitlyChosen;
              currentError = result.error;
              draftKey = contentHash(currentPatch);
              // GitButler adopts updated stack topology. Plain git keeps the launch-frozen
              // session context — currentBranch labels the launch cwd in
              // WorktreePicker and the feedback branch label, and adopting a
              // switched worktree's recomputed context here would repoint
              // those on the next reload.
              const adoptContext =
                updatedContext !== undefined &&
                sessionVcsType === "gitbutler";
              const nextClientContext = adoptContext
                ? updatedContext
                : clientGitContext;
              if (nextClientContext) {
                clientGitContext = {
                  ...nextClientContext,
                  diffFallback: availability.fallback
                    ? {
                        requestedDiffType,
                        effectiveDiffType: newDiffType,
                        message: availability.fallback.message,
                        candidates: availability.fallback.candidates,
                      }
                    : undefined,
                };
              }
              if (updatedContext && sessionVcsType === "gitbutler") {
                currentContextRevision = updatedContextRevision ?? "";
              }
              captureDiffFingerprint(result.fingerprint, nextDraftTarget);
              return Response.json({
                rawPatch: currentPatch,
                // Snapshot args: robust against a future await sneaking in
                // between the epoch check and this response.
                aiReviewContext: buildCurrentAiReviewContext(result.patch),
                gitRef: currentGitRef,
                snapshotId: currentSnapshotId(),
                localDraftTarget: nextDraftTarget,
                ...(nextDraftTarget && { draftState: reviewDrafts.state({ ...localReviewDraftKeys(draftKey, nextDraftTarget), legacyPatchKey: undefined }) }),
                approvalNotesSupported,

                serverSession,
                imagePreviewSupported,
                ...(await imageSizesAdvert(currentPatch)),
                markdownPreviewSupported,
                repoFilesSupported,
                ...sourceKindAdvert,
                diffType: currentDiffType,
                // Echo the base the server actually used. resolveBaseBranch
                // trusts the caller verbatim; this echo lets the client
                // confirm the request landed (and pick it up when the client
                // didn't supply one and we fell back to detected default).
                base: currentBase,
                hideWhitespace: currentHideWhitespace,
                ...(sections && { sections }),
                ...(commitInfo && { commitInfo }),
                ...(generatedFiles && { generatedFiles }),
                // The response still carries a transiently recomputed context
                // (worktree switches on plain git) even when the session did
                // not adopt it — matching the pre-jj-line behavior.
                // Emitted only when a context was actually recomputed: on a
                // same-cwd commit:<sha> switch (recompute skipped) the client
                // keeps what it has. Echoing the launch-frozen session context
                // here would revert the base picker and commit-baseline list
                // on every Commits-rail click.
                ...(updatedContext
                  ? {
                      gitContext: {
                        ...updatedContext,
                        diffFallback: clientGitContext?.diffFallback,
                      },
                    }
                  : {}),
                ...(currentError && { error: currentError }),
                callFlow: switchCallFlow,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to switch diff";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Switch PR diff scope between the platform layer diff and a local full-stack diff.

          // API: List PRs for the current repo (cached for 30s)

          // API: Switch to a different PR in the stack (in-place navigation)

          // API: Fetch PR context (comments, checks, merge status) — PR mode only

          // API: Fetch a context-referenced HTML/Markdown artifact through the
          // authenticated provider session. The shared helper owns URL and
          // redirect validation so this never becomes an open proxy.

          // API: Serve provider media and resources derived from a referenced
          // artifact document. The helper validates both the source document
          // and target URL before forwarding provider credentials.


          // API: An image a reviewed Markdown file shows, read at that side's
          // revision. Every decision is in the shared handler.
          if (url.pathname === REVIEW_MARKDOWN_IMAGE_ENDPOINT && req.method === "GET") {
            const result = await handleReviewMarkdownImageRequest({
              params: url.searchParams,
              ifNoneMatch: req.headers.get("if-none-match"),
              available: imagePreviewSupported,
              patch: currentPatch,
              markdownExtensions: getExtraMarkdownExtensions(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              signal: req.signal,
              readSide: (side, filePath, oldPath, maxBytes, signal) =>
                runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
            });
            return new Response(result.body as BodyInit | null, {
              status: result.status,
              headers: result.headers,
            });
          }

          // API: One side of a changed image, as bytes (#1598). Every decision
          // (eligibility, caps, sniffing, headers) is in the shared handler;
          // readReviewSide only says where the current mode reads a side from.
          if (url.pathname === REVIEW_IMAGE_SIZES_ENDPOINT && req.method === "GET") {
            const result = await handleReviewImageSizesRequest({
              params: url.searchParams,
              available: imagePreviewSupported,
              patch: currentPatch,
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              signal: req.signal,
              readSide: (side, filePath, oldPath, maxBytes, signal) =>
                runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
            });
            return new Response(result.body as BodyInit | null, { status: result.status, headers: result.headers });
          }

          if (url.pathname === REVIEW_IMAGE_ENDPOINT && req.method === "GET") {
            const result = await handleReviewImageRequest({
              params: url.searchParams,
              ifNoneMatch: req.headers.get("if-none-match"),
              available: imagePreviewSupported,
              patch: currentPatch,
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              signal: req.signal,
              readSide: (side, filePath, oldPath, maxBytes, signal) =>
                runImageRead(() => readReviewSide(side, filePath, oldPath, maxBytes, signal), signal),
            });
            return new Response(result.body as BodyInit | null, {
              status: result.status,
              headers: result.headers,
            });
          }

          // --- All files: the repository at the diff's new side ------------
          // Where this mode lists and reads: the local VCS, the PR's checkout
          // (or the platform's tree API without one), or the workspace's repos.
          const repoFilesUnavailable = (): RepoFilesUnavailable | null => {
            if (isStaticPatchMode) {
              return { reason: "static-patch", message: "A patch file has no repository to list." };
            }
            if (sessionVcsType === "p4") {
              return { reason: "unsupported", message: "All files is not available for Perforce reviews." };
            }
            if (!workspace && !hasLocalAccess) {
              return { reason: "unsupported", message: "This review has no repository to list." };
            }
            return null;
          };
          const loadRepoListing = async (): Promise<RepoFileListing | null> => {
            return repoListing.get(currentSnapshotId(), async () => {
              if (workspace) return workspace.listFiles();
              if (!hasLocalAccess) return null;
              return listVcsFiles(currentDiffType as DiffType, currentBase, gitContext?.cwd);
            });
          };
          const readListedRepoFile = async (path: string, maxBytes: number): Promise<RepoFileRead> => {
            if (workspace) return workspace.getFileBytes(path, undefined, "new", maxBytes);
            return getVcsFileBytesForDiff(currentDiffType as DiffType, currentBase, path, undefined, "new", maxBytes, gitContext?.cwd);
          };

          // API: The repository's files at the diff's new side (the tree's All files).
          if (url.pathname === REPO_FILES_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFilesRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              loadOnDisk: (listing) =>
                listing.root
                  ? findRepoOnDiskChanges(gitRuntime, listing.root, diffFileStates(currentPatch), snapshotCapturedAt)
                  : Promise.resolve(null),
              lazyThreshold: options.repoFilesLazyThreshold,
            });
            return Response.json(result.body, { status: result.status });
          }

          // API: Go to File over the listing (the client searches a listing it
          // holds itself; past the lazy threshold it asks here).
          if (url.pathname === REPO_FILES_SEARCH_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFilesSearchRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              preferred: new Set(diffFileStates(currentPatch).keys()),
            });
            return Response.json(result.body, { status: result.status });
          }

          // API: Live updates for a working-tree listing (one event per settled burst of writes).
          if (url.pathname === REPO_FILES_STREAM_ENDPOINT && req.method === "GET") {
            const snapshot = url.searchParams.get("snapshot");
            if (!snapshot) return Response.json({ error: "Missing snapshot", reason: "bad-request" }, { status: 400 });
            const unavailable = repoFilesUnavailable();
            if (unavailable) return Response.json({ error: unavailable.message, reason: unavailable.reason }, { status: 400 });
            if (snapshot !== currentSnapshotId()) return Response.json({ error: "Diff snapshot is stale; refresh first", reason: "stale" }, { status: 409 });
            const listing = await loadRepoListing();
            if (!listing?.live || !listing.root) {
              return Response.json({ error: "This listing does not change while the review is open", reason: "not-live" }, { status: 400 });
            }
            const root = listing.root;
            const liveWorkspace = workspace;
            return repoWatch.stream(root, {
              mode: repoLiveMode(listing, { workspace: !!liveWorkspace, lazyThreshold: options.repoFilesLazyThreshold }),
              signature: liveWorkspace
                ? async () => (await liveWorkspace.listFiles())?.paths.join("\n") ?? null
                : () => gitLiveSignature(gitRuntime, root),
              ignored: liveWorkspace ? undefined : () => gitIgnoredEntries(gitRuntime, root),
              onChange: () => repoListing.invalidate(),
              pollMs: options.repoLivePollMs,
              signal: req.signal,
            }, () => server.timeout(req, 0));
          }

          // API: One file of the listing, as text (any file, changed or not).
          if (url.pathname === REPO_FILE_ENDPOINT && req.method === "GET") {
            const result = await handleRepoFileRequest({
              params: url.searchParams,
              unavailable: repoFilesUnavailable(),
              isCurrentSnapshot: (snapshot) => snapshot === currentSnapshotId(),
              loadListing: loadRepoListing,
              read: readListedRepoFile,
              readWorkingTree: readRepoWorkingTreeFile,
            });
            return Response.json(result.body, { status: result.status });
          }

          // API: Get file content for expandable diff context
          if (url.pathname === "/api/file-content" && req.method === "GET") {
            // No working tree behind a static patch: the patch IS the whole
            // content of the session, so there is nothing to expand into.
            if (isStaticPatchMode) {
              return Response.json(
                { error: "File content is unavailable for a static patch review" },
                { status: 400 },
              );
            }
            const filePath = url.searchParams.get("path");
            if (!filePath) {
              return Response.json({ error: "Missing path" }, { status: 400 });
            }
            try { validateFilePath(filePath); } catch {
              return Response.json({ error: "Invalid path" }, { status: 400 });
            }
            const oldPath = url.searchParams.get("oldPath") || undefined;
            if (oldPath) {
              try { validateFilePath(oldPath); } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }
            }

            // File expansion must describe the exact patch the requesting tab
            // rendered. Reject cross-tab switches and mutable VCS changes
            // instead of combining an old patch with newly-resolved contents.
            const requestedSnapshot = url.searchParams.get("snapshot");
            if (requestedSnapshot) {
              if (requestedSnapshot !== currentSnapshotId()) {
                return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
              }
              const baselineGeneration = fingerprintGeneration;
              let baseline = currentFingerprint;
              const pendingCapture = pendingFingerprintCapture;
              if (baseline == null && pendingCapture) {
                baseline = await pendingCapture;
              }
              if (
                requestedSnapshot !== currentSnapshotId() ||
                baselineGeneration !== fingerprintGeneration
              ) {
                return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
              }
              if (baseline != null) {
                const probe = await fileContentFingerprintProbes.run(
                  `${requestedSnapshot}:${baselineGeneration}`,
                  computeDiffFingerprint,
                );
                if (
                  requestedSnapshot !== currentSnapshotId() ||
                  currentFingerprint !== baseline ||
                  (probe != null && probe !== baseline)
                ) {
                  return Response.json({ error: "Diff snapshot is stale; refresh before expanding context" }, { status: 409 });
                }
              }
            }

            const result = await readDiffFileContents(filePath, oldPath, url.searchParams.get("base") ?? undefined);
            if ("error" in result) return Response.json(result, { status: 400 });
            return Response.json(result);
          }

          // API: Package changes under package.json and lockfile diffs. Read
          // only: the lookup below is the one route that reaches npm.
          if (url.pathname === "/api/package-changes" && req.method === "GET") {
            if (isStaticPatchMode) {
              return Response.json({ error: "Package changes need the files behind the diff" }, { status: 400 });
            }
            const out = await packageChanges.get({
              snapshot: url.searchParams.get("snapshot"),
              base: url.searchParams.get("base") ?? undefined,
            });
            return Response.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
          }

          // API: npm details for one package card. POST, so the cross-origin
          // write guard refuses another site's request; 403 until the
          // reviewer turned the lookup on.
          if (url.pathname === "/api/package-changes/lookup" && req.method === "POST") {
            if (isStaticPatchMode) {
              return Response.json({ error: "Package changes need the files behind the diff" }, { status: 400 });
            }
            let body: unknown;
            try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
            const out = await packageChanges.lookup(body);
            return Response.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
          }

          // API: Code navigation (search-based symbol resolution)
          if (url.pathname === "/api/code-nav/resolve" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd;
            if (!hasCodeNavAccess) {
              return Response.json(
                { error: "Code navigation requires local access" },
                { status: 400 },
              );
            }
            // PR mode: the checkout must actually exist — ripgrep over a
            // fallback directory returns confidently-wrong results.
            const navCwd = resolveAgentCwd();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            const changedFiles = extractChangedFiles(currentPatch);
            return handleCodeNavResolve(req, navCwd, changedFiles);
          }

          // API: Code navigation hover card (same guards as /resolve — the
          // hover pipeline reads exactly what Cmd+click reads).
          if (url.pathname === "/api/code-nav/hover" && req.method === "POST") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd;
            if (!hasCodeNavAccess) {
              return Response.json(
                { error: "Code navigation requires local access" },
                { status: 400 },
              );
            }
            // PR mode: the checkout must actually exist — ripgrep over a
            // fallback directory returns confidently-wrong results.
            const navCwd = resolveAgentCwd();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            const changedFiles = extractChangedFiles(currentPatch);
            return handleCodeNavHover(req, navCwd, changedFiles);
          }

          // API: Code navigation file preview (read file from working tree)
          if (url.pathname === "/api/code-nav/file" && req.method === "GET") {
            if (isGitButlerCommittedView()) {
              return Response.json(
                { error: "Code navigation is unavailable for committed GitButler views" },
                { status: 400 },
              );
            }
            const hasCodeNavAccess = !!workspace || !!gitContext || !!options.agentCwd;
            if (!hasCodeNavAccess) {
              return Response.json({ error: "Code navigation requires local access" }, { status: 400 });
            }
            const navCwd = resolveAgentCwd();
            if (!navCwd) {
              return Response.json({ error: "Local checkout unavailable" }, { status: 400 });
            }
            // Links followed like an editor; 5 MB cap and no FIFO hang
            // (packages/shared/repo-file.ts, the Pi server uses the same).
            const read = await readRepoFile(navCwd, url.searchParams.get("path"), { decode: decodeBunText });
            if (!read.ok) {
              return Response.json(repoFileErrorBody(read), { status: REPO_FILE_ERROR_STATUS[read.reason] });
            }
            return Response.json({ content: read.content });
          }

          // API: Stage / unstage a file (disabled when VCS doesn't support it)
          if (url.pathname === "/api/git-add" && req.method === "POST") {
            if (isStaticPatchMode) {
              return Response.json(
                { error: "Staging is unavailable for a static patch review" },
                { status: 400 },
              );
            }
            try {
              const body = (await req.json()) as { filePath?: unknown; undo?: boolean };
              if (typeof body.filePath !== "string" || !body.filePath) {
                return Response.json({ error: "Missing filePath" }, { status: 400 });
              }
              try { validateFilePath(body.filePath); } catch {
                return Response.json({ error: "Invalid path" }, { status: 400 });
              }

              if (workspace) {
                try {
                  await workspace.stageFile(body.filePath, body.undo);
                  return Response.json({ ok: true });
                } catch (error) {
                  return Response.json(
                    { error: error instanceof Error ? error.message : "Failed to stage file" },
                    { status: 400 },
                  );
                }
              }

              const stageCwd = resolveVcsCwd(currentDiffType as DiffType, gitContext?.cwd);
              if (
                (sessionVcsType && !vcsOwnsDiffType(sessionVcsType, currentDiffType as string)) ||
                !(await canStageFiles(currentDiffType as DiffType, stageCwd))
              ) {
                return Response.json(
                  { error: "Staging not available" },
                  { status: 400 },
                );
              }

              if (body.undo) {
                await unstageFile(currentDiffType as DiffType, body.filePath, stageCwd);
              } else {
                await stageFile(currentDiffType as DiffType, body.filePath, stageCwd);
              }

              return Response.json({ ok: true });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Failed to stage file";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Update user config (write-back to ~/.plannotator/config.json)
          if (url.pathname === "/api/config" && req.method === "POST") {
            if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin config writes are not allowed" }, { status: 403 });
            }
            try {
              const body = (await req.json()) as { diffOptions?: Record<string, unknown>; theme?: Record<string, unknown>; favicon?: FaviconStyle; reviewAnalysis?: Record<string, unknown>; packageChanges?: unknown; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
              const toSave: Record<string, unknown> = {};
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.theme !== undefined) toSave.theme = body.theme;
              if (isFaviconStyle(body.favicon)) toSave.favicon = body.favicon;
              if (body.reviewAnalysis !== undefined) {
                const reviewAnalysis = parseReviewAnalysisConfig(body.reviewAnalysis);
                if (!reviewAnalysis) {
                  return Response.json({ error: "Invalid analysis settings" }, { status: 400 });
                }
                toSave.reviewAnalysis = reviewAnalysis;
                if (reviewAnalysis.callFlow === false) callFlowService.cancelAll();
              }
              // Package changes: the card switch and the npm lookup consent, booleans only.
              if (body.packageChanges !== undefined) {
                const packageChangesConfig = parsePackageChangesConfig(body.packageChanges);
                if (!packageChangesConfig) return Response.json({ error: "Invalid packageChanges" }, { status: 400 });
                toSave.packageChanges = packageChangesConfig;
              }
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
              // The cookie switch (#2184): its own write, which never replaces another urlHost;
              // refused in remote mode and --tailscale sessions.
              const cookieHostWrite = cookieHostConfigWrite((body as { cookieHost?: unknown }).cookieHost, isRemote);
              if (cookieHostWrite && cookieHostWrite.status !== 200) return Response.json(cookieHostWrite.body, { status: cookieHostWrite.status });
              if (Object.keys(toSave).length > 0 && !saveConfig(toSave as Parameters<typeof saveConfig>[0])) return Response.json({ error: "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it." }, { status: 500 });
              return Response.json(cookieHostWrite ? cookieHostWrite.body : { ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Review profiles (custom reviews discovery). Reloaded per
          // request, no file watching. Profiles come from the user dir plus
          // builtins.
          if (url.pathname === "/api/agents/review-profiles" && req.method === "GET") {
            // Catalog only — directory listing, no SKILL.md bodies read here.
            // Bodies are read at launch, for the one selected skill.
            const body: ReviewProfilesResponse = {
              profiles: [
                {
                  id: BUILTIN_DEFAULT_PROFILE.id,
                  label: BUILTIN_DEFAULT_PROFILE.label,
                  source: BUILTIN_DEFAULT_PROFILE.source,
                  default: BUILTIN_DEFAULT_PROFILE.default,
                },
                ...discoverCuratedSkills().map((s) => ({
                  id: `skill:${s.name}`,
                  label: s.name,
                  source: "user" as const,
                  sourcePath: s.sourcePath,
                })),
              ],
            };
            return Response.json(body);
          }

          // API: All discovered skills, for the "add a review" picker. Each is
          // flagged with whether it is already enabled as a review.
          if (url.pathname === "/api/agents/skills" && req.method === "GET") {
            return Response.json({ skills: listAllSkills() });
          }

          // API: Enable a skill as a review (curation write to review-skills.json).
          if (url.pathname === "/api/agents/review-skills" && req.method === "POST") {
            let name: unknown;
            try {
              ({ name } = (await req.json()) as { name?: unknown });
            } catch {
              return Response.json({ error: "Invalid JSON" }, { status: 400 });
            }
            if (typeof name !== "string" || name.length === 0) {
              return Response.json({ error: "`name` is required." }, { status: 400 });
            }
            try {
              return Response.json(enableReviewSkill(name));
            } catch (err) {
              return Response.json(
                { error: err instanceof Error ? err.message : "Could not enable review." },
                { status: 400 },
              );
            }
          }

          // API: Guided Review standing instructions (#1265) — server-owned,
          // stored in the data dir like review-skills.json. Guide launches
          // apply the stored text when the launch body carries none.
          if (url.pathname === "/api/agents/guide-instructions") {
            if (req.method === "GET") {
              return Response.json({ instructions: readGuideInstructions() });
            }
            if (req.method === "PUT") {
              let instructions: unknown;
              try {
                ({ instructions } = (await req.json()) as { instructions?: unknown });
              } catch {
                return Response.json({ error: "Invalid JSON" }, { status: 400 });
              }
              if (typeof instructions !== "string") {
                return Response.json({ error: "`instructions` must be a string." }, { status: 400 });
              }
              return Response.json({ instructions: writeGuideInstructions(instructions) });
            }
          }

          // API: Durable viewed-file progress
          if (url.pathname === "/api/review-progress") {
            if (req.method === "POST" && !callFlowInstallOriginAllowed(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
              return Response.json({ error: "Cross-origin progress updates are not allowed" }, { status: 403 });
            }
            let body: unknown;
            if (req.method === "POST") {
              try {
                body = await req.json();
              } catch {
                return Response.json({ error: "Invalid JSON" }, { status: 400 });
              }
            }
            const result = await handleReviewProgress({
              method: req.method, snapshotId: url.searchParams.get("snapshot"),
              currentSnapshotId, progress: progressSnapshot, currentProgress: () => progressSnapshot,
              body, platformViewed: [],
            });
            return Response.json(result.body, { status: result.status });
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            const keys = currentDraftKeys();
            if (url.searchParams.has("target") && url.searchParams.get("target") !== keys.targetKey) {
              return Response.json({ code: "draft_target_changed", error: "Review draft target changed" }, { status: 409 });
            }
            if (req.method === "POST") {
              try {
                const saved = reviewDrafts.save(keys, await req.json(), url.searchParams.get("client"));
                // Target-backed drafts report stale saves; unsupported surfaces
                // retain the historical always-ok response.
                if (!saved && keys.targetKey) {
                  return Response.json(
                    { ok: false, error: "stale draft generation", ...reviewDrafts.state(keys) },
                    { status: 409 },
                  );
                }
                return Response.json({ ok: true });
              } catch (err) {
                const message = err instanceof Error ? err.message : "Failed to save draft";
                console.error(`[draft] save failed: ${message}`);
                return Response.json({ error: message }, { status: 500 });
              }
            }
            if (req.method === "DELETE") {
              reviewDrafts.remove(keys, readDraftGenerationFromUrl(req), url.searchParams.get("client"));
              return Response.json({ ok: true });
            }
            const loaded = reviewDrafts.load(keys, url.searchParams.get("client"));
            if (loaded.found) return Response.json(loaded.draft);
            return missingDraftResponse(loaded.draftGeneration);
          }

          // API: Editor annotations (VS Code extension)
          if (isGitButlerCommittedView() && url.pathname === "/api/editor-annotations" && req.method === "GET") {
            return Response.json({ annotations: [] });
          }
          if (isGitButlerCommittedView() && url.pathname === "/api/editor-annotation" && req.method === "POST") {
            return Response.json(
              { error: "Editor annotations are unavailable for committed GitButler views" },
              { status: 400 },
            );
          }
          const editorResponse = await editorAnnotations.handle(req, url);
          if (editorResponse) return editorResponse;

          // API: Live PR context stream (comments, checks, merge state)

          // API: External annotations (SSE-based, for any external tool)
          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          // API: Agent jobs (background review agents)
          const agentResponse = await agentJobs.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (agentResponse) return agentResponse;

          // API: Exit review session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            // Already decided (the host closed it, or another tab decided):
            // archiving or settling now would delete a draft the close kept.
            // Exit posts carry no body: the nonce rides the query string.
            if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, serverSession) === "mismatch") {
              return Response.json(serverSessionMismatchBody(), { status: 409 });
            }
            if (reviewDecided) return reviewAlreadyDecided();
            // Decision-only line: a dismissal carries no content, and how
            // often reviews are closed without feedback is exactly the
            // behavior data the archive exists to answer.
            archiveReviewSubmission("", [], "dismissed");
            reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromUrl(req), url.searchParams.get("client"));
            resolveDecision({ approved: false, feedback: "", annotations: [], exit: true });
            return Response.json({ ok: true });
          }

          // API: Submit review feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                approved?: boolean;
                feedback: string;
                annotations: unknown[];
                draftGeneration?: number;
                platform?: unknown;
              };
              if (checkServerSession(body, serverSession) === "mismatch") {
                return Response.json(serverSessionMismatchBody(), { status: 409 });
              }

              // Checked after the body is read: a host close can land while
              // it streams. A decided session must not archive, delete the
              // draft, or answer ok for feedback nobody will receive.
              if (reviewDecided) return reviewAlreadyDecided();

              // Archive BEFORE the draft delete: a failed write keeps the
              // draft as the reviewer's recovery copy (#678 ordering).
              // Defensive on the body's own types: a malformed value must
              // degrade to the legacy behavior (settle + 200), never throw.
              const approved = body.approved ?? false;
              const feedbackValue = body.feedback || "";
              const annotationsValue = body.annotations || [];
              const hasContent =
                (typeof feedbackValue === "string" && feedbackValue.trim().length > 0) ||
                (Array.isArray(annotationsValue) && annotationsValue.length > 0);
              const durable = archiveReviewSubmission(
                feedbackValue,
                annotationsValue,
                approved ? (hasContent ? "approved-with-notes" : "lgtm") : "feedback",
              );
              if (durable) reviewDrafts.settle(currentDraftKeys(), readDraftGenerationFromBody(body), url.searchParams.get("client"));
              resolveDecision({
                approved,
                feedback: feedbackValue,
                ...(options.includeReviewDirectory && !isStaticPatchMode
                  ? { reviewDirectory: resolveAgentCwd() } : {}),
                annotations: annotationsValue,
                // The platform path's status post marks itself; only a real
                // boolean true counts, so consumers never infer it from an
                // empty annotation list (PR description, PR comment and
                // editor comments ride only in `feedback`).
                ...(body.platform === true && { platform: true as const }),
              });

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Submit PR review directly to GitHub (PR mode only)

          // API: Mark/unmark PR files as viewed on GitHub (PR mode, GitHub only)

          // AI endpoints
          if (url.pathname.startsWith("/api/ai/")) {
            if (!aiRuntime) {
              if (!isAIEndpointPath(url.pathname)) {
                return handleApiNotFound(url.pathname);
              }
              if (url.pathname.slice("/api/ai/".length) === "capabilities" && req.method === "GET") {
                return Response.json({ available: false, providers: [] });
              }
              return Response.json({ error: "AI backend not available" }, { status: 503 });
            }
            const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
            if (handler) {
              // AI sessions pin their cwd at creation — wait out the PR
              // checkout warmup so a session opened in the first seconds
              // isn't rooted in a transient fallback directory for life.
              // If the checkout can't be produced (warmup failed), refuse
              // instead of starting a session in the wrong directory.
              if (isLongLivedAIEndpointPath(url.pathname)) {
                server.timeout(req, 0);
              }
              return handler(req);
            }
            return handleApiNotFound(url.pathname);
          }

          // Favicon
          if (url.pathname === "/favicon.png" || url.pathname === "/favicon.ico") return handleFavicon(url.pathname);
          if (url.pathname === "/plannotator-themes.js" && req.method === "GET") return handleCustomThemesScript(url.searchParams);

          // Code review's diagram engine, fetched by the page only for a
          // preview or guide overview that holds a diagram fence.
          if (isDiagramEngineRequest(url.pathname)) {
            const answer = await answerDiagramEngineRequest(
              diagramEngineAssets,
              url.pathname,
              req.method,
              req.headers.get("accept-encoding"),
              compressAppHtml,
            );
            return new Response(answer.body as BodyInit, { status: answer.status, headers: answer.headers });
          }

          if (isSemDiffRequest(url.pathname)) {
            const answer = await answerSemDiffRequest(
              semDiffAssets,
              url.pathname,
              req.method,
              req.headers.get("accept-encoding"),
              compressAppHtml,
            );
            return new Response(answer.body as BodyInit, { status: answer.status, headers: answer.headers });
          }

          if (isSemDiffOpinionRequest(url.pathname)) {
            const answer = await answerSemDiffOpinionRequest(url.pathname, req.method, () => req.json(), semDiffOpinionDataDir());
            return Response.json(answer.body, { status: answer.status, headers: { "Cache-Control": "no-store" } });
          }

          // API 404 guard: unknown /api/* routes should return JSON, not HTML
          if (url.pathname.startsWith("/api/")) {
            return handleApiNotFound(url.pathname);
          }

          // Serve the app for all other routes (SPA): the page or a packed asset
          return packedAppResponse(app, req, url.pathname, compressAppHtml);
        },

        error(err) {
          console.error("[plannotator] Server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        },
    })),
  );

  const port = server.port!;
  serverUrl = buildAdvertisedUrl(port);
  const exitHandler = () => agentJobs.killAll();
  process.once("exit", exitHandler);

  const stop = () => {
    process.removeListener("exit", exitHandler);
    agentJobs.dispose();
    callFlowService.cancelAll();
    aiRuntime?.dispose();
    repoWatch.closeAll();
    server.stop();
    // Invoke cleanup callback (e.g., remove temp worktree)
    if (options.onCleanup) {
      try {
        const result = options.onCleanup();
        if (result instanceof Promise) result.catch(() => {});
      } catch { /* best effort */ }
    }
  };

  // Start the likely encoding now (gzip for plain-http remote mode, brotli
  // behind tailscale serve) so the first load does not wait for it.
  if (compressAppHtml) {
    prewarmAppHtml(app.page(), likelyAppHtmlEncoding(false));
  }

  // Notify caller that server is ready. An async ready handler that rejects
  // (e.g. --tailscale publishing failed) must stop the server and propagate:
  // firing-and-forgetting it would leave an unhandled rejection while the
  // loopback server keeps listening and the session hangs forever.
  if (onReady) {
    try {
      await onReady(serverUrl, isRemote, port);
    } catch (error) {
      stop();
      throw error;
    }
  }

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop,
  };
}
