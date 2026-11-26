/**
 * "Open Plannotator at plannotator.localhost" (#2184) through the Bun servers:
 * POST /api/config `{ cookieHost }` writes or removes `urlHost:
 * "plannotator.localhost"`, never replaces another `urlHost` (a tailnet name,
 * `auto`, an IP), is locked while PLANNOTATOR_URL_HOST is set, and is refused
 * (and not advertised) in remote mode. A live app session stays on localhost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_URL_HOST", "PLANNOTATOR_OPENCODE_URL"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-cookie-host-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_OPENCODE_URL = "";
  delete process.env.PLANNOTATOR_PORT;
  delete process.env.PLANNOTATOR_URL_HOST;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const configFile = () => join(dataDir, "config.json");
const writeConfig = (value: Record<string, unknown>) => writeFileSync(configFile(), JSON.stringify(value, null, 2) + "\n");
/** Requests go to 127.0.0.1: a session started after the switch is advertised at plannotator.localhost. */
const base = (server: { port: number }) => `http://127.0.0.1:${server.port}`;
const post = (server: { port: number }, body: unknown) =>
  fetch(`${base(server)}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const payloadPath = { review: "/api/diff", annotate: "/api/plan" } as const;

const servers = {
  review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
  annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
};

describe("cookieHost through POST /api/config", () => {
  for (const [name, start] of Object.entries(servers) as Array<[keyof typeof servers, () => Promise<{ port: number; url: string; stop: () => void }>]>) {
    test(`${name}: on writes urlHost, off removes it, other config is kept, a non-boolean is refused`, async () => {
      writeConfig({ displayName: "tater" });
      const server = await start();
      const serverConfig = async () =>
        ((await (await fetch(`${base(server)}${payloadPath[name]}`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
      try {
        expect((await serverConfig()).cookieHost).toEqual({ on: false });
        const on = await post(server, { cookieHost: true });
        expect(on.status).toBe(200);
        expect((await on.json()).cookieHost).toEqual({ on: true });
        expect(loadConfig()).toEqual({ displayName: "tater", urlHost: "plannotator.localhost" });
        expect((await serverConfig()).cookieHost).toEqual({ on: true });
        expect((await post(server, { cookieHost: false })).status).toBe(200);
        expect(loadConfig()).toEqual({ displayName: "tater" });
        expect((await post(server, { cookieHost: "yes" })).status).toBe(400);
        expect(loadConfig()).toEqual({ displayName: "tater" });
      } finally {
        server.stop();
      }
    });
  }

  for (const other of ["my-machine.tailnet.ts.net", "auto", "100.64.0.9", "work.localhost"]) {
    test(`never replaces or removes another urlHost (${other}): the switch is locked`, async () => {
      writeConfig({ urlHost: other });
      const before = readFileSync(configFile(), "utf8");
      // Remote mode would advertise the tailnet name; this session is local, so it still answers on loopback.
      const server = await servers.annotate();
      try {
        const config = ((await (await fetch(`${base(server)}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
        expect(config.cookieHost).toEqual({ on: false, urlHost: other });
        for (const value of [true, false]) {
          const res = await post(server, { cookieHost: value });
          expect(res.status).toBe(409);
          expect((await res.json()).code).toBe("cookie_host_url_host_in_use");
          expect(readFileSync(configFile(), "utf8")).toBe(before);
        }
      } finally {
        server.stop();
      }
    });
  }

  test("PLANNOTATOR_URL_HOST locks the switch and nothing is written", async () => {
    const server = await servers.annotate();
    try {
      process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
      const config = ((await (await fetch(`${base(server)}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
      expect(config.cookieHost).toEqual({ on: true, env: "plannotator.localhost" });
      const res = await post(server, { cookieHost: false });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("cookie_host_env_decides");
      expect(loadConfig().urlHost).toBeUndefined();
      process.env.PLANNOTATOR_URL_HOST = "";
      expect((await post(server, { cookieHost: true })).status).toBe(409);
      expect(loadConfig().urlHost).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("remote mode: not advertised, and a write is refused", async () => {
    process.env.PLANNOTATOR_REMOTE = "1";
    const probe = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("") });
    process.env.PLANNOTATOR_PORT = String(probe.port);
    probe.stop(true);
    const server = await servers.annotate();
    try {
      const config = ((await (await fetch(`${base(server)}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
      expect(config.cookieHost).toBeUndefined();
      const res = await post(server, { cookieHost: true });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("cookie_host_local_only");
      expect(loadConfig().urlHost).toBeUndefined();
    } finally {
      server.stop();
    }
  });
});

describe("the advertised address with a localhost subdomain configured", () => {
  test("a document session opens there; a live app session stays on localhost", async () => {
    process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("<html><head><title>app</title></head><body>app</body></html>", { headers: { "Content-Type": "text/html" } }),
    });
    const doc = await servers.annotate();
    const targetUrl = `http://127.0.0.1:${app.port}`;
    const live = await startAnnotateServer({
      markdown: "",
      filePath: targetUrl,
      htmlContent: MINIMAL_HTML,
      mode: "annotate-app",
      sourceInfo: targetUrl,
      liveApp: { targetUrl, bridgeScript: "/* bridge */", bridgeBootstrap: "/* bootstrap */", annotationCss: ".pn-live {}" },
    });
    try {
      expect(doc.url).toBe(`http://plannotator.localhost:${doc.port}`);
      expect(live.url).toBe(`http://localhost:${live.port}`);
    } finally {
      doc.stop();
      live.stop();
      app.stop(true);
    }
  });
});
