import {
  type AgentJobInfo, type AgentJobEvent, type AgentCapabilities,
  isTerminalStatus, jobSource, launchLabelOf, serializeAgentSSEEvent,
  AGENT_HEARTBEAT_COMMENT, AGENT_HEARTBEAT_INTERVAL_MS,
} from "@plannotator/shared/agent-jobs";
import { resolveGuideLaunchInstructions } from "@plannotator/shared/guide-instructions-store";
import type { GuideLaunchReview } from "@plannotator/shared/guide-format";
import { crossOriginRefusalBody } from "@plannotator/shared/request-origin";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { isSameOriginRequest } from "./request-origin-guard";

export type { AgentJobInfo, AgentJobEvent, AgentCapabilities } from "@plannotator/shared/agent-jobs";

type JobKind = "opencode" | "guide";

interface JobInput {
  reviewProfileId?: string;
  repairOf?: string;
  instructions?: string;
}

interface JobLaunch {
  cwd: string;
  label: string;
  prompt: string;
  diffContext?: AgentJobInfo["diffContext"];
  guideContext?: AgentJobInfo["guideContext"];
  reviewProfileId?: string;
  reviewProfileLabel?: string;
  changedFilesSnapshot?: string[];
  launchReview?: GuideLaunchReview;
}

export interface AgentJobHandlerOptions {
  serverSession: string;
  generate?: (prompt: string, cwd: string, signal: AbortSignal) => Promise<string>;
  prepare: (kind: JobKind, input: JobInput) => Promise<JobLaunch>;
  onJobComplete: (job: AgentJobInfo, result: {
    text: string;
    cwd: string;
    changedFilesSnapshot?: string[];
    launchReview?: GuideLaunchReview;
  }) => Promise<void>;
}

const ROOT = "/api/agents";
const JOBS = `${ROOT}/jobs`;
const LAUNCH_KEYS = new Set(["provider", "label", "reviewProfileId", "repairOf", "instructions", "serverSession"]);

export function createAgentJobHandler(options: AgentJobHandlerOptions) {
  const jobs = new Map<string, { info: AgentJobInfo; abort: AbortController; completing?: boolean }>();
  const subscribers = new Map<ReadableStreamDefaultController<Uint8Array>, ReturnType<typeof setInterval>>();
  const encoder = new TextEncoder();
  let version = 0;
  let closed = false;

  const snapshots = () => Array.from(jobs.values(), ({ info }) => ({ ...info }));
  const frame = (event: AgentJobEvent) => encoder.encode(serializeAgentSSEEvent(event));

  function unsubscribe(controller: ReadableStreamDefaultController<Uint8Array>) {
    clearInterval(subscribers.get(controller));
    subscribers.delete(controller);
  }

  function broadcast(event: AgentJobEvent) {
    version++;
    const data = frame(event);
    for (const controller of subscribers.keys()) {
      try { controller.enqueue(data); } catch { unsubscribe(controller); }
    }
  }

  function kill(id: string): boolean {
    const entry = jobs.get(id);
    if (!entry || entry.completing || isTerminalStatus(entry.info.status)) return false;
    entry.abort.abort();
    entry.info.status = "killed";
    entry.info.endedAt = Date.now();
    broadcast({ type: "job:completed", job: { ...entry.info } });
    return true;
  }

  function killAll(): number {
    let count = 0;
    for (const id of jobs.keys()) if (kill(id)) count++;
    return count;
  }

  return {
    killAll,
    dispose() {
      closed = true;
      killAll();
      for (const controller of subscribers.keys()) {
        unsubscribe(controller);
        try { controller.close(); } catch { /* Already closed. */ }
      }
    },
    getJob(id: string): AgentJobInfo | undefined {
      const entry = jobs.get(id);
      return entry ? { ...entry.info } : undefined;
    },
    completeJobExternally(id: string, summary: AgentJobInfo["summary"]): boolean {
      const info = jobs.get(id)?.info;
      if (!info || (info.status !== "failed" && info.status !== "killed")) return false;
      Object.assign(info, { status: "done", exitCode: 0, summary, error: undefined });
      broadcast({ type: "job:completed", job: { ...info } });
      return true;
    },
    async handle(req: Request, url: URL, handler?: { disableIdleTimeout?: () => void }): Promise<Response | null> {
      if (url.pathname === `${ROOT}/capabilities` && req.method === "GET") {
        const available = !!options.generate;
        return Response.json({
          mode: "review",
          available,
          providers: available ? [
            { id: "opencode", name: "OpenCode", available },
            { id: "guide", name: "Guided Review", available },
          ] : [],
        } satisfies AgentCapabilities);
      }
      if (url.pathname === `${JOBS}/stream` && req.method === "GET") {
        handler?.disableIdleTimeout?.();
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            ctrl = controller;
            controller.enqueue(frame({ type: "snapshot", jobs: snapshots() }));
            subscribers.set(controller, setInterval(() => {
              try { controller.enqueue(encoder.encode(AGENT_HEARTBEAT_COMMENT)); }
              catch { unsubscribe(controller); }
            }, AGENT_HEARTBEAT_INTERVAL_MS));
          },
          cancel: () => unsubscribe(ctrl),
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      if (url.pathname === JOBS && req.method === "GET") {
        const since = url.searchParams.get("since");
        if (since !== null && Number(since) === version) return new Response(null, { status: 304 });
        return Response.json({ jobs: snapshots(), version });
      }
      if (!isSameOriginRequest(req) && (url.pathname === JOBS || url.pathname.startsWith(`${JOBS}/`))) {
        return Response.json(crossOriginRefusalBody(), { status: 403 });
      }
      if (req.method === "DELETE" && (url.pathname === JOBS || url.pathname.startsWith(`${JOBS}/`))) {
        if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, options.serverSession) === "mismatch") {
          return Response.json(serverSessionMismatchBody(), { status: 409 });
        }
        if (url.pathname === JOBS) return Response.json({ ok: true, killed: killAll() });
        const ok = kill(url.pathname.slice(JOBS.length + 1));
        return ok ? Response.json({ ok }) : Response.json({ error: "Job not found or already terminal" }, { status: 404 });
      }
      if (url.pathname !== JOBS || req.method !== "POST") return null;
      if (!options.generate || closed) return Response.json({ error: "OpenCode V2 is unavailable." }, { status: 503 });
      const generate = options.generate;
      let body: Record<string, unknown>;
      try {
        const json: unknown = await req.json();
        if (typeof json !== "object" || !json || Array.isArray(json)) throw new Error();
        body = json as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Invalid job request." }, { status: 400 });
      }
      if (checkServerSession(body, options.serverSession) === "mismatch") {
        return Response.json(serverSessionMismatchBody(), { status: 409 });
      }
      const kind = body.provider;
      if ((kind !== "opencode" && kind !== "guide") || Object.keys(body).some(key => !LAUNCH_KEYS.has(key))) {
        return Response.json({ error: "Only server-configured OpenCode review jobs are supported." }, { status: 400 });
      }
      let launch: JobLaunch;
      try {
        launch = await options.prepare(kind, {
          reviewProfileId: typeof body.reviewProfileId === "string" ? body.reviewProfileId : undefined,
          repairOf: typeof body.repairOf === "string" ? body.repairOf : undefined,
          instructions: kind === "guide" ? resolveGuideLaunchInstructions(body.instructions) : undefined,
        });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Could not prepare review." }, { status: 503 });
      }
      if (closed) return Response.json({ error: "Review closed." }, { status: 503 });
      const id = crypto.randomUUID();
      const { cwd, label, diffContext, guideContext, reviewProfileId, reviewProfileLabel } = launch;
      const info: AgentJobInfo = {
        id, source: jobSource(id), provider: kind, engine: "opencode", label, cwd, command: [],
        status: "running", startedAt: Date.now(), launchLabel: launchLabelOf(body.label, label),
        diffContext, guideContext, reviewProfileId, reviewProfileLabel,
      };
      const abort = new AbortController();
      const entry: { info: AgentJobInfo; abort: AbortController; completing?: boolean } = { info, abort };
      jobs.set(id, entry);
      broadcast({ type: "job:started", job: { ...info } });
      void (async () => {
        try {
          const text = await generate(launch.prompt, cwd, abort.signal);
          if (abort.signal.aborted) return;
          entry.completing = true;
          // Prompt and review contents stay server-side; the parser needs the nonce.
          const completed = { ...info, prompt: launch.prompt };
          await options.onJobComplete(completed, {
            text, cwd, changedFilesSnapshot: launch.changedFilesSnapshot, launchReview: launch.launchReview,
          });
          if (abort.signal.aborted) return;
          info.status = completed.status === "running" ? "done" : completed.status;
          info.summary = completed.summary;
          info.error = completed.error;
        } catch (error) {
          if (abort.signal.aborted) return;
          info.status = "failed";
          info.error = error instanceof Error ? error.message : "OpenCode review failed.";
        }
        info.endedAt = Date.now();
        broadcast({ type: "job:completed", job: { ...info } });
      })();
      return Response.json({ job: info }, { status: 201 });
    },
  };
}
