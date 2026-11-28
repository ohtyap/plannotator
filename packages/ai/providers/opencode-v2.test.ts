import { expect, test } from "bun:test";
import { configuredOpenCode, OpenCodeV2, OpenCodeV2Provider } from "./opencode-v2";
import type { AIMessage } from "../types";

async function collect(messages: AsyncIterable<AIMessage>) {
  const result: AIMessage[] = [];
  for await (const message of messages) result.push(message);
  return result;
}

test("Ask AI generates text without creating a session and keeps follow-up context local to each chat", async () => {
  const requests: Array<{ path: string; auth: string | null; directory: string | null; body?: { prompt: string } }> = [];
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push({
        path, auth: req.headers.get("authorization"), directory: req.headers.get("x-opencode-directory"),
        body: req.method === "POST" ? await req.json() as { prompt: string } : undefined,
      });
      if (path === "/api/info") return Response.json({ version: "2.4.1" });
      if (path === "/api/experimental/generate/text" && req.method === "POST") {
        return Response.json({ data: { text: `Réponse ${requests.length - 1}` } });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const client = configuredOpenCode({ PLANNOTATOR_OPENCODE_URL: service.url.origin, OPENCODE_PASSWORD: "only-on-server" })!;
    expect(await client.available()).toBe(true);
    const provider = new OpenCodeV2Provider(client, "/fallback");
    const options = {
      cwd: "/checkout/a worktree",
      context: { mode: "code-review" as const, review: { patch: "+checkout change" } },
    };
    const chat = await provider.createSession(options);
    const fresh = await provider.createSession(options);
    expect(requests.map(r => r.path)).toEqual(["/api/info"]);
    expect(await collect(chat.query("What changed?"))).toEqual([
      { type: "text_delta", delta: "Réponse 1" },
      { type: "result", sessionId: chat.id, success: true },
    ]);
    await collect(chat.query("Why?"));
    await collect(fresh.query("Summarize"));
    expect(requests.map(r => r.path)).toEqual(["/api/info", ...Array(3).fill("/api/experimental/generate/text")]);
    expect(requests.every(r => r.auth === `Basic ${Buffer.from("opencode:only-on-server").toString("base64")}`)).toBe(true);
    expect(requests.slice(1).every(r => r.directory === encodeURIComponent(options.cwd))).toBe(true);
    expect(requests[2].body!.prompt).toContain("+checkout change");
    expect(requests[2].body!.prompt).toContain("What changed?");
    expect(requests[2].body!.prompt).toContain("Réponse 1");
    expect(requests[2].body!.prompt).toContain("Why?");
    expect(requests[3].body!.prompt).not.toContain("What changed?");
    expect(requests[3].body!.prompt).not.toContain("Réponse 1");
  } finally {
    service.stop(true);
  }
});

test("stopping Ask AI discards that turn and allows another question without a session interrupt", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const paths: string[] = [];
  const prompts: string[] = [];
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      paths.push(path);
      if (path !== "/api/experimental/generate/text") return new Response(null, { status: 404 });
      prompts.push((await req.json() as { prompt: string }).prompt);
      if (prompts.length === 1) {
        started.resolve();
        await release.promise;
      }
      return Response.json({ data: { text: "Answer" } });
    },
  });
  try {
    const provider = new OpenCodeV2Provider(new OpenCodeV2(service.url.origin), "/checkout");
    const chat = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } });
    const outcome = collect(chat.query("Discard this question"));
    await started.promise;
    chat.abort();
    release.resolve();
    expect(await outcome).toEqual([]);
    expect(await collect(chat.query("Try again"))).toEqual([
      { type: "text_delta", delta: "Answer" },
      { type: "result", sessionId: chat.id, success: true },
    ]);
    expect(prompts[1]).not.toContain("Discard this question");
    expect(paths).toEqual(Array(2).fill("/api/experimental/generate/text"));
  } finally {
    release.resolve();
    service.stop(true);
  }
}, 5_000);

test("does not discover a service or send credentials over non-loopback HTTP", () => {
  expect(configuredOpenCode({})).toBeNull();
  expect(configuredOpenCode({ PLANNOTATOR_OPENCODE_URL: "http://example.com", OPENCODE_PASSWORD: "secret" })).toBeNull();
});

test("long conversations drop older turns without losing the document or recent exchanges", async () => {
  const prompts: string[] = [];
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      prompts.push((await req.json() as { prompt: string }).prompt);
      const text = prompts.length < 3 ? "A".repeat(35_000) : "Final answer";
      return Response.json({ data: { text } });
    },
  });
  try {
    const provider = new OpenCodeV2Provider(new OpenCodeV2(service.url.origin), "/checkout");
    const chat = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Test plan" } } });
    await collect(chat.query("Old question"));
    await collect(chat.query("Recent question"));
    await collect(chat.query("Follow-up"));
    expect(prompts[2]).toContain("# Test plan");
    expect(prompts[2]).not.toContain("Old question");
    expect(prompts[2]).toContain("Recent question");
    expect(prompts[2]).toContain("Follow-up");
  } finally {
    service.stop(true);
  }
});
