import { childPath } from "@plannotator/shared/child-env";
import {
  createAIEndpoints,
  createDeferredModelDiscovery,
  createProvider,
  ProviderRegistry,
  SessionManager,
  type AIEndpoints,
  type PiSDKConfig,
  type QwenSDKConfig,
} from "@plannotator/ai";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";

export interface AIRuntime {
  endpoints: AIEndpoints;
  dispose: () => void;
}

export const AI_QUERY_ENDPOINT = "/api/ai/query";

interface CreateAIRuntimeOptions {
  cwd?: string;
  getCwd?: () => string;
}

export async function createAIRuntime(options: CreateAIRuntimeOptions = {}): Promise<AIRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  // Model discovery spawns the provider's CLI, so it runs on first explicit
  // activation (?activate= from a model picker) or the first session — never
  // at startup.
  const discovery = createDeferredModelDiscovery();
  const deferModelDiscovery = discovery.defer;

  const registerSdkProviders = async (registry: ProviderRegistry): Promise<void> => {
    try {
      await import("@plannotator/ai/providers/claude-agent-sdk");
      const claudePath = Bun.which("claude", { PATH: childPath() });
      const provider = await createProvider({
        type: "claude-agent-sdk",
        cwd,
        ...(claudePath && { claudeExecutablePath: claudePath }),
      });
      const providerId = registry.register(provider);
      // A Claude session spawns its own `claude`, so it never waits on discovery
      // (~2s, up to 10s): the first Ask AI answer starts at once.
      deferModelDiscovery(providerId, provider, { blockSession: false });
    } catch {
      // Claude SDK not available.
    }

    try {
      await import("@plannotator/ai/providers/codex-app-server");
      const codexPath = Bun.which("codex", { PATH: childPath() });
      if (codexPath) {
        const provider = await createProvider({
          type: "codex-sdk",
          cwd,
          ...(codexPath ? { codexExecutablePath: codexPath } : {}),
        });
        const providerId = registry.register(provider);
        deferModelDiscovery(providerId, provider);
      }
    } catch {
      // Codex not available.
    }

    try {
      await import("@plannotator/ai/providers/pi-sdk");
      const rawPiPath = Bun.which("pi", { PATH: childPath() });
      if (rawPiPath) {
        const piPath = resolveWindowsCommandShim(rawPiPath);
        const provider = await createProvider({
          type: "pi-sdk",
          cwd,
          piExecutablePath: piPath,
        } as PiSDKConfig);
        const providerId = registry.register(provider);
        // Deferred like Codex: fetchModels spawns `pi` (up to 10s), and done
        // eagerly it held every plain /api/ai/capabilities answer until it
        // finished, even when a session bridge replaced the SDK providers. A
        // Pi session spawns its own `pi` and runs on Pi's default model when
        // none is picked, so it never waits on discovery either.
        deferModelDiscovery(providerId, provider, { blockSession: false });
      }
    } catch {
      // Pi not available.
    }

    try {
      await import("@plannotator/ai/providers/opencode-sdk");
      const opencodePath = Bun.which("opencode", { PATH: childPath() });
      if (opencodePath) {
        const provider = await createProvider({
          type: "opencode-sdk",
          cwd,
        });
        const providerId = registry.register(provider);
        // Deferred like Codex: fetchModels spawns `opencode serve`, so it must
        // NOT run eagerly at startup — that spawned a server on every session
        // for every user with opencode installed, and interrupted sessions
        // orphaned it. The initializer runs on first explicit activation
        // (?activate= from the model picker) or first opencode session.
        deferModelDiscovery(providerId, provider);
      }
    } catch {
      // OpenCode not available.
    }

    try {
      await import("@plannotator/ai/providers/qwen-sdk");
      const rawQwenPath = Bun.which("qwen", { PATH: childPath() });
      if (rawQwenPath) {
        const provider = await createProvider({
          type: "qwen-sdk",
          cwd,
          qwenExecutablePath: resolveWindowsCommandShim(rawQwenPath),
        } as QwenSDKConfig);
        const providerId = registry.register(provider);
        // Discovery reads Qwen Code's settings.json (no process), and a
        // session runs on qwen's own default model when none is picked.
        deferModelDiscovery(providerId, provider, { blockSession: false });
      }
    } catch {
      // Qwen Code not available.
    }
  };

  await registerSdkProviders(registry);

  const endpoints = createAIEndpoints({
    registry,
    sessionManager,
    getCwd: options.getCwd,
    beforeProviderSession: discovery.beforeProviderSession,
  });

  return {
    endpoints,
    dispose: () => {
      sessionManager.disposeAll();
      registry.disposeAll();
    },
  };
}
