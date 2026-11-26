import { expect, test } from "bun:test";
import { configuredOpenCode, OpenCodeV2, OpenCodeV2Provider } from "./opencode-v2";
import type { AIMessage } from "../types";

const bytes = new TextEncoder();
const event = (type: string, data: Record<string, unknown> = {}) => `data: ${JSON.stringify({ type, data })}\r\n\r\n`;

test("connects to V2, keeps credentials server-side, and streams only the owned session", async () => {
  const requests: Array<{ path: string; auth: string | null; body?: unknown }> = [];
  let feed: ReadableStreamDefaultController<Uint8Array>;
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({ path, auth: req.headers.get("authorization"), body: req.headers.has("content-type") ? await req.json() : undefined });
      if (path === "/api/info") return Response.json({ version: "2.4.1" });
      if (path === "/api/session") return Response.json({ data: { id: "ses_owned" } });
      if (path === "/api/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(ctrl) {
            feed = ctrl;
            ctrl.enqueue(bytes.encode(event("server.connected")));
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (path === "/api/session/ses_owned/prompt") {
        const frame = bytes.encode(
          event("session.text.delta", { sessionID: "ses_other", delta: "unrelated" }) +
          event("session.text.delta", { sessionID: "ses_owned", assistantMessageID: "msg_1", ordinal: 0, delta: "héllo" }) +
          event("session.text.ended", { sessionID: "ses_owned", assistantMessageID: "msg_1", ordinal: 0, text: "héllo" }) +
          event("session.execution.succeeded", { sessionID: "ses_owned" }),
        );
        feed.enqueue(frame.slice(0, 31));
        feed.enqueue(frame.slice(31));
        return Response.json({ data: {} });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const client = configuredOpenCode({ PLANNOTATOR_OPENCODE_URL: service.url.origin, OPENCODE_PASSWORD: "only-on-server" })!;
    expect(await client.available()).toBe(true);
    const provider = new OpenCodeV2Provider(client, "/fallback");
    const session = await provider.createSession({
      cwd: "/checkout/a worktree",
      model: "ignored",
      context: { mode: "code-review", review: { patch: "+checkout change" } },
    });
    const answer: AIMessage[] = [];
    for await (const message of session.query("What changed?")) answer.push(message);
    expect(answer).toEqual([
      { type: "text_delta", delta: "héllo" },
      { type: "result", sessionId: "ses_owned", success: true },
    ]);
    expect(requests.map(r => r.path)).toEqual(["/api/info", "/api/session", "/api/event", "/api/session/ses_owned/prompt"]);
    expect(requests.every(r => r.auth === `Basic ${Buffer.from("opencode:only-on-server").toString("base64")}`)).toBe(true);
    expect(requests[1].body).toMatchObject({
      location: { directory: "/checkout/a worktree" },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    });
    expect(requests[1].body).not.toHaveProperty("model");
    expect(requests[1].body).not.toHaveProperty("parentID");
    expect((requests[3].body as { text: string }).text).toContain("+checkout change");
  } finally {
    service.stop(true);
  }
});

test("interrupts only the session whose submitted turn was stopped", async () => {
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
  const paths: string[] = [];
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (path === "/api/event") return new Response(new ReadableStream({
        start(ctrl) { ctrl.enqueue(bytes.encode(event("server.connected"))); },
      }), { headers: { "Content-Type": "text/event-stream" } });
      if (path.endsWith("/prompt")) {
        acknowledge();
        return Response.json({ data: {} });
      }
      return new Response(null, { status: 204 });
    },
  });
  try {
    const stop = new AbortController();
    const client = new OpenCodeV2(service.url.origin);
    const run = client.prompt("ses_owned", "Question", stop.signal).next();
    const outcome = run.then(() => null, (error: unknown) => error);
    await acknowledged;
    stop.abort();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(paths).toEqual(["/api/event", "/api/session/ses_owned/prompt", "/api/session/ses_owned/interrupt"]);
  } finally {
    service.stop(true);
  }
}, 5_000);

test("does not discover a service or send credentials over non-loopback HTTP", () => {
  expect(configuredOpenCode({})).toBeNull();
  expect(configuredOpenCode({ PLANNOTATOR_OPENCODE_URL: "http://example.com", OPENCODE_PASSWORD: "secret" })).toBeNull();
});
