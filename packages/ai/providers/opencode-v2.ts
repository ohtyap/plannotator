import { BaseSession } from "../base-session";
import { buildEffectivePrompt, buildForkPreamble, buildSystemPrompt } from "../context";
import type { AIMessage, AIProvider, AISession, CreateSessionOptions } from "../types";

type V2Event = { type?: string; data?: Record<string, unknown> };
const TURN_TIMEOUT = 300_000;

/** Preconfigured, server-side connection. Never discovers or starts a service. */
export function configuredOpenCode(env = process.env): OpenCodeV2 | null {
  const password = env.OPENCODE_PASSWORD;
  const endpoint = env.PLANNOTATOR_OPENCODE_URL ?? (password ? "http://127.0.0.1:49375" : undefined);
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (url.protocol === "http:" && !["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname)) return null;
    return new OpenCodeV2(url.origin, password);
  } catch {
    return null;
  }
}

/** Small client for the OpenCode V2 HTTP and SSE contract. */
export class OpenCodeV2 {
  constructor(private readonly origin: string, private readonly password?: string) {}

  private async request(path: string, init: RequestInit = {}, directory?: string): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.password) headers.set("Authorization", `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`);
    if (init.body) headers.set("Content-Type", "application/json");
    if (directory) headers.set("x-opencode-directory", encodeURIComponent(directory));
    let response: Response;
    try {
      response = await fetch(`${this.origin}${path}`, { ...init, headers, redirect: "error" });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new Error("Could not reach the configured OpenCode V2 service.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OpenCode V2 request failed (HTTP ${response.status}).`);
    }
    return response;
  }

  async available(): Promise<boolean> {
    try {
      const response = await this.request("/api/info", { signal: AbortSignal.timeout(1_500) });
      const body = await response.json() as { version?: unknown; data?: { version?: unknown } };
      const version = body.data?.version ?? body.version;
      return typeof version === "string" && /^2\./.test(version);
    } catch {
      return false;
    }
  }

  async createSession(directory: string): Promise<string> {
    const response = await this.request("/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "Plannotator · Ask AI",
        location: { directory },
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const { data } = await response.json() as { data?: { id?: unknown } };
    if (typeof data?.id !== "string" || !data.id) throw new Error("OpenCode did not return a session ID.");
    return data.id;
  }

  async interrupt(id: string): Promise<void> {
    await this.request(`/api/session/${encodeURIComponent(id)}/interrupt`, { method: "POST", signal: AbortSignal.timeout(5_000) });
  }

  async generate(prompt: string, directory: string, signal: AbortSignal): Promise<string> {
    const response = await this.request("/api/experimental/generate/text", {
      method: "POST",
      body: JSON.stringify({ prompt }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TURN_TIMEOUT)]),
    }, directory);
    const { data } = await response.json() as { data?: { text?: unknown } };
    if (typeof data?.text !== "string" || !data.text.trim()) throw new Error("OpenCode returned no review output.");
    return data.text;
  }

  async *prompt(id: string, text: string, signal: AbortSignal): AsyncGenerator<AIMessage> {
    const streamAbort = new AbortController();
    const requestSignal = AbortSignal.any([signal, streamAbort.signal, AbortSignal.timeout(TURN_TIMEOUT)]);
    const response = await this.request("/api/event", { signal: requestSignal, headers: { Accept: "text/event-stream" } });
    if (!response.body) throw new Error("OpenCode did not open an event stream.");
    const events = readEvents(response.body, requestSignal);
    let submitted = false;
    let finished = false;
    try {
      const first = await events.next();
      if (first.done || first.value.type !== "server.connected") throw new Error("OpenCode did not acknowledge the event stream.");
      requestSignal.throwIfAborted();
      submitted = true;
      const promptResponse = await this.request(`/api/session/${encodeURIComponent(id)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
        // Let the enqueue settle before interrupting. Closing the POST socket
        // does not prove that OpenCode did not accept the turn.
        signal: AbortSignal.timeout(10_000),
      });
      // Drain the acknowledgment before consuming the already-open feed.
      void promptResponse.body?.cancel().catch(() => {});
      requestSignal.throwIfAborted();
      const streamed = new Map<string, string>();
      for await (const event of events) {
        const data = event.data;
        if (data?.sessionID !== id) continue;
        const part = `${data.assistantMessageID}:${data.ordinal}`;
        if (event.type === "session.text.delta" && typeof data.delta === "string" && data.delta) {
          streamed.set(part, (streamed.get(part) ?? "") + data.delta);
          yield { type: "text_delta", delta: data.delta };
        } else if (event.type === "session.text.ended" && typeof data.text === "string") {
          const prefix = streamed.get(part) ?? "";
          if (data.text.startsWith(prefix) && data.text.length > prefix.length) {
            yield { type: "text_delta", delta: data.text.slice(prefix.length) };
          }
        } else if (event.type === "session.execution.succeeded") {
          finished = true;
          yield { type: "result", sessionId: id, success: true };
          return;
        } else if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          finished = true;
          throw new Error("OpenCode did not complete the answer.");
        }
      }
      throw new Error("The OpenCode event stream closed before the answer completed.");
    } finally {
      streamAbort.abort();
      const streamClosed = events.return(undefined).catch(() => {});
      if (submitted && !finished) await this.interrupt(id).catch(() => {});
      void streamClosed;
    }
  }
}

async function* readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<V2Event> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield JSON.parse(data) as V2Event;
      }
      if (pending.length > 4_000_000) throw new Error("OpenCode sent an oversized event.");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Only sessions created here can be queried or interrupted by Plannotator. */
export class OpenCodeV2Provider implements AIProvider {
  readonly name = "opencode";
  readonly label = "OpenCode";
  readonly capabilities = { fork: false, resume: false, streaming: true, tools: false };

  constructor(private readonly client: OpenCodeV2, private readonly cwd: string) {}

  async createSession({ context, cwd }: CreateSessionOptions): Promise<AISession> {
    const id = await this.client.createSession(cwd ?? this.cwd);
    const preamble = context.mode === "code-review" ? buildForkPreamble(context) : buildSystemPrompt(context);
    return new ChatSession(id, this.client, preamble);
  }

  async forkSession(): Promise<never> { throw new Error("OpenCode conversations are isolated from the active agent session."); }
  async resumeSession(): Promise<never> { throw new Error("OpenCode conversations cannot be resumed by external session ID."); }
  dispose(): void {}
}

class ChatSession extends BaseSession {
  private retired = false;

  constructor(id: string, private readonly client: OpenCodeV2, private readonly preamble: string) {
    super({ initialId: id, parentSessionId: null });
  }

  override abort(): void {
    if (this.isActive) this.retired = true;
    super.abort();
  }

  async *query(text: string): AsyncGenerator<AIMessage> {
    if (this.retired) {
      yield { type: "error", error: "Start a new Ask AI conversation after an interrupted turn." };
      return;
    }
    const turn = this.startQuery();
    if (!turn) { yield BaseSession.BUSY_ERROR; return; }
    let finished = false;
    try {
      const prompt = buildEffectivePrompt(text, this.preamble, this._firstQuerySent);
      for await (const message of this.client.prompt(this.id, prompt, turn.signal)) {
        if (message.type === "result") {
          finished = true;
          this._firstQuerySent = true;
        }
        yield message;
      }
    } catch (error) {
      if (!turn.signal.aborted) yield { type: "error", error: error instanceof Error ? error.message : "OpenCode request failed." };
    } finally {
      if (!finished) this.retired = true;
      this.endQuery(turn.gen);
    }
  }

  dispose(): void { this.abort(); }
}
