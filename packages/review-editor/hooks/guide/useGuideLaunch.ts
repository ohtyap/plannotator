import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import type { AgentCapabilities } from '@plannotator/ui/types';

export function useGuideLaunch(capabilities: AgentCapabilities | null) {
  return {
    canLaunch: capabilities?.providers.some(provider => provider.id === 'guide' && provider.available) === true,
    buildParams(instructions?: string): AgentLaunchParams {
      return {
        provider: 'guide',
        label: 'Guided Review',
        ...(instructions !== undefined && { instructions }),
      };
    },
  };
}
