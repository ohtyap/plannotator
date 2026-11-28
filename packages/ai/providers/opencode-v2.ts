import { BaseSession } from "../base-session";
import { buildEffectivePrompt, buildForkPreamble, buildSystemPrompt } from "../context";
import type { AIMessage, AIProvider, AISession, CreateSessionOptions } from "../types";

const TURN_TIMEOUT = 300_000;
const HISTORY_LIMIT = 64_000;

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

/** Small client for stateless OpenCode V2 text generation. */
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
}

/** Ask AI chat IDs and history belong to Plannotator, not OpenCode. */
export class OpenCodeV2Provider implements AIProvider {
  readonly name = "opencode";
  readonly label = "OpenCode";
  readonly capabilities = { fork: false, resume: false, streaming: false, tools: false };

  constructor(private readonly client: OpenCodeV2, private readonly cwd: string) {}

  async createSession({ context, cwd }: CreateSessionOptions): Promise<AISession> {
    const preamble = context.mode === "code-review" ? buildForkPreamble(context) : buildSystemPrompt(context);
    return new ChatSession(this.client, cwd ?? this.cwd, preamble);
  }

  async forkSession(): Promise<never> { throw new Error("OpenCode conversations are isolated from the active agent session."); }
  async resumeSession(): Promise<never> { throw new Error("OpenCode conversations cannot be resumed by external session ID."); }
  dispose(): void {}
}

class ChatSession extends BaseSession {
  private history: string[] = [];
  private historySize = 0;

  constructor(private readonly client: OpenCodeV2, private readonly cwd: string, private readonly preamble: string) {
    super({ parentSessionId: null });
  }

  async *query(text: string): AsyncGenerator<AIMessage> {
    const turn = this.startQuery();
    if (!turn) { yield BaseSession.BUSY_ERROR; return; }
    try {
      const context = this.history.length
        ? `${this.preamble}\n\n## Previous Ask AI turns (conversation context)\n${this.history.join("\n")}`
        : this.preamble;
      const prompt = buildEffectivePrompt(text, context, false);
      const answer = await this.client.generate(prompt, this.cwd, turn.signal);
      turn.signal.throwIfAborted();

      // Keep complete pairs only; failed and cancelled questions never enter history.
      const pair = JSON.stringify({ question: text, answer });
      this.history.push(pair);
      this.historySize += pair.length + 1;
      while (this.historySize > HISTORY_LIMIT) {
        this.historySize -= this.history.shift()!.length + 1;
      }
      // The browser still consumes its usual events, but OpenCode returns the
      // entire answer in one response.
      yield { type: "text_delta", delta: answer };
      yield { type: "result", sessionId: this.id, success: true };
    } catch (error) {
      if (!turn.signal.aborted) yield { type: "error", error: error instanceof Error ? error.message : "OpenCode request failed." };
    } finally {
      this.endQuery(turn.gen);
    }
  }

  dispose(): void {
    this.abort();
    this.history = [];
    this.historySize = 0;
  }
}
