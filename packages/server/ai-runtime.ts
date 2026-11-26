import { createAIEndpoints, ProviderRegistry, SessionManager, type AIEndpoints } from "@plannotator/ai";
import { configuredOpenCode, OpenCodeV2Provider, type OpenCodeV2 } from "@plannotator/ai/providers/opencode-v2";

export interface AIRuntime {
  endpoints: AIEndpoints;
  openCode: OpenCodeV2;
  dispose: () => void;
}

export const AI_QUERY_ENDPOINT = "/api/ai/query";

export async function createAIRuntime({ cwd = process.cwd(), getCwd }: { cwd?: string; getCwd?: () => string } = {}): Promise<AIRuntime | null> {
  const openCode = configuredOpenCode();
  if (!openCode || !(await openCode.available())) return null;
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  registry.register(new OpenCodeV2Provider(openCode, cwd));
  return {
    endpoints: createAIEndpoints({ registry, sessionManager, getCwd }),
    openCode,
    dispose: () => {
      sessionManager.disposeAll();
      registry.disposeAll();
    },
  };
}
