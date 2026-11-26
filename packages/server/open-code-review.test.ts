import { expect, test } from "bun:test";
import { startReviewServer } from "./review";
import { startAnnotateServer } from "./annotate";
import { extractMarkerNonce, markerClose, markerOpen } from "./marker-review";

const patch = "diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-Old\n+New wording\n";

test("Review Agent and Guided Review use the captured patch with no model or provider overrides", async () => {
  const envKeys = ["PLANNOTATOR_OPENCODE_URL", "OPENCODE_PASSWORD"] as const;
  const old = envKeys.map(key => process.env[key]);
  const prompts: string[] = [];
  let responseText = "";
  let hold = false;
  let requested!: () => void;
  const pending = new Promise<void>(resolve => { requested = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const openCode = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/info") return Response.json({ version: "2.4.1" });
      if (path !== "/api/experimental/generate/text") return new Response(null, { status: 404 });
      const body = await req.json() as { prompt: string };
      expect(Object.keys(body)).toEqual(["prompt"]);
      prompts.push(body.prompt);
      if (hold) {
        requested();
        await wait;
      }
      const nonce = extractMarkerNonce(body.prompt)!;
      return Response.json({ data: { text: `${markerOpen(nonce)}\n${responseText}\n${markerClose(nonce)}` } });
    },
  });
  let review: Awaited<ReturnType<typeof startReviewServer>> | undefined;
  try {
    process.env.PLANNOTATOR_OPENCODE_URL = openCode.url.origin;
    delete process.env.OPENCODE_PASSWORD;
    review = await startReviewServer({
      htmlContent: "<!doctype html><html><body>review</body></html>",
      rawPatch: patch, gitRef: "Patch", diffType: "static-patch",
    });
    const get = (path: string) => fetch(new URL(path, review!.url));
    const launch = (body: unknown) => fetch(new URL("/api/agents/jobs", review!.url), {
      method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    });
    const jobList = async () => (await (await get("/api/agents/jobs")).json()).jobs as Array<{ id: string; status: string; summary?: { correctness: string }; prompt?: string }>;
    const terminal = async (id: string) => {
      for (let check = 0; check < 50; check++) {
        const job = (await jobList()).find(job => job.id === id);
        if (job && job.status !== "running") return job;
        await Bun.sleep(10);
      }
      throw new Error("Review job did not finish");
    };

    const capabilities = await (await get("/api/ai/capabilities")).json();
    expect(capabilities.providers.map((provider: { id: string }) => provider.id)).toEqual(["opencode"]);
    const agentCaps = await (await get("/api/agents/capabilities")).json();
    expect(agentCaps.providers.map((provider: { id: string }) => provider.id)).toEqual(["opencode", "guide"]);
    expect((await launch({ provider: "claude" })).status).toBe(400);
    expect((await launch({ provider: "opencode", model: "override" })).status).toBe(400);
    expect(prompts).toHaveLength(0);

    responseText = JSON.stringify({ findings: [], summary: { correctness: "Correct", explanation: "Clear change.", confidence: 1 } });
    const reviewJob = (await (await launch({ provider: "opencode" })).json()).job;
    expect(await terminal(reviewJob.id)).toMatchObject({ status: "done", summary: { correctness: "Correct" } });
    expect(reviewJob).not.toHaveProperty("prompt");
    expect(prompts[0]).toContain("+New wording");

    responseText = JSON.stringify({
      title: "Wording change", intent: "Clarify the readme",
      sections: [{ title: "Documentation", overview: "The readme uses clearer wording.", diffs: [{ file: "readme.md", summary: "Rewords the first line." }] }],
      unplacedFiles: [],
    });
    const guideJob = (await (await launch({ provider: "guide" })).json()).job;
    expect(await terminal(guideJob.id)).toMatchObject({ status: "done" });
    expect((await get(`/api/guide/${guideJob.id}`)).ok).toBe(true);
    expect(prompts[1]).toContain("+New wording");

    responseText = '{"sections":[]}';
    const malformed = (await (await launch({ provider: "guide" })).json()).job;
    expect(await terminal(malformed.id)).toMatchObject({ status: "failed" });
    expect((await get(`/api/guide/${malformed.id}`)).ok).toBe(false);

    hold = true;
    const cancelled = (await (await launch({ provider: "opencode" })).json()).job;
    await pending;
    expect((await fetch(new URL(`/api/agents/jobs/${cancelled.id}`, review.url), { method: "DELETE" })).ok).toBe(true);
    release();
    expect(await terminal(cancelled.id)).toMatchObject({ status: "killed" });
  } finally {
    release();
    review?.stop();
    openCode.stop(true);
    envKeys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
  }
}, 10_000);

test.each([
  { connection: "missing configuration", available: false, requests: 0 },
  { connection: "an unavailable service", available: false, requests: 2 },
  { connection: "a reachable V2 service", available: true, requests: 2 },
])("review and annotate use OpenCode availability with $connection", async ({ connection, available, requests }) => {
  const envKeys = ["PLANNOTATOR_OPENCODE_URL", "OPENCODE_PASSWORD", "PLANNOTATOR_AI"] as const;
  const old = envKeys.map(key => process.env[key]);
  const probes: string[] = [];
  const openCode = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      probes.push(new URL(req.url).pathname);
      return available ? Response.json({ version: "2.4.1" }) : new Response(null, { status: 503 });
    },
  });
  const servers: Array<{ url: string; stop(): void }> = [];
  const htmlContent = "<!doctype html><html><body>test</body></html>";
  try {
    delete process.env.OPENCODE_PASSWORD;
    if (connection === "missing configuration") delete process.env.PLANNOTATOR_OPENCODE_URL;
    else process.env.PLANNOTATOR_OPENCODE_URL = openCode.url.origin;
    // A stale value from an older launcher must not gate a working connection.
    process.env.PLANNOTATOR_AI = "disabled";
    const review = await startReviewServer({ htmlContent, rawPatch: patch, gitRef: "Patch", diffType: "static-patch" });
    servers.push(review);
    servers.push(await startAnnotateServer({ htmlContent, markdown: "# Document", filePath: "doc.md" }));
    for (const server of servers) {
      const response = await fetch(new URL("/api/ai/capabilities", server.url));
      expect(await response.json()).toMatchObject({
        available,
        providers: available ? [{ id: "opencode" }] : [],
      });
      if (!available) expect((await fetch(new URL("/api/ai/query", server.url), { method: "POST" })).status).toBe(503);
    }
    const diff = await (await fetch(new URL("/api/diff", review.url))).json();
    expect(diff).toMatchObject({ rawPatch: patch, aiEnabled: available });
    if (available) expect(diff.aiReviewContext).toContain("+New wording");
    else expect(diff).not.toHaveProperty("aiReviewContext");
    const agentCaps = await (await fetch(new URL("/api/agents/capabilities", review.url))).json();
    expect(agentCaps).toMatchObject({
      available,
      providers: available ? [{ id: "opencode" }, { id: "guide" }] : [],
    });
    if (!available) {
      const response = await fetch(new URL("/api/agents/jobs", review.url), {
        method: "POST", body: JSON.stringify({ provider: "opencode" }),
      });
      expect(response.status).toBe(503);
    }
    expect(probes).toEqual(Array(requests).fill("/api/info"));
  } finally {
    servers.forEach(server => server.stop());
    openCode.stop(true);
    envKeys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key];
      else process.env[key] = old[i];
    });
  }
});
