import React, { useEffect, useMemo, useState } from 'react';
import { Square } from 'lucide-react';
import type { AgentJobInfo, AgentCapabilities } from '../types';
import { isTerminalStatus } from '@plannotator/core/agent-jobs';
import { GUIDE_ENGINE_LABEL } from '@plannotator/core/guide';
import type { ReviewEngine } from '../hooks/useAgentSettings';
import type { AgentLaunchParams } from '../hooks/useAgentJobs';
import { JobRow, formatDuration, ElapsedTime } from './agents/JobRow';
import { AddReviewDialog } from './agents/AddReviewDialog';
import { findingsOf, type FindingLike } from './agents/jobFindings';

export type { AgentLaunchParams } from '../hooks/useAgentJobs';
export { formatDuration, ElapsedTime };
export type { FindingLike };

export const REVIEW_ENGINE_LABEL: Record<ReviewEngine, string> = GUIDE_ENGINE_LABEL;

export type AgentLaunchResult = AgentJobInfo | null | void;

const DEFAULT_PROFILE = { id: 'builtin:default', label: 'Default' };

interface AgentsTabProps {
  jobs: AgentJobInfo[];
  capabilities: AgentCapabilities | null;
  onLaunch: (params: AgentLaunchParams) => AgentLaunchResult | Promise<AgentLaunchResult>;
  onKillJob: (id: string) => void;
  onKillAll: () => void;
  externalAnnotations: readonly FindingLike[];
  onOpenJobDetail?: (jobId: string) => void;
  onOpenGuide?: (jobId: string) => void;
  onOpenFinding?: (finding: FindingLike) => void;
  guideLaunchable?: boolean;
  canOpenGuideJob?: (job: AgentJobInfo) => boolean;
  scope?: React.ReactNode;
  guides?: () => React.ReactNode;
}

function SectionTitle({ children, trailing }: { children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
      <h3 className="text-[12px] font-medium text-muted-foreground">{children}</h3>
      {trailing}
    </div>
  );
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  jobs,
  capabilities,
  onLaunch,
  onKillJob,
  onKillAll,
  externalAnnotations,
  onOpenJobDetail,
  onOpenGuide,
  onOpenFinding,
  guideLaunchable = true,
  canOpenGuideJob,
  scope,
  guides,
}) => {
  const reviewReady = capabilities?.providers.some(p => p.id === 'opencode' && p.available) === true;
  const guideReady = guideLaunchable && capabilities?.providers.some(p => p.id === 'guide' && p.available) === true;
  const [addReviewOpen, setAddReviewOpen] = useState(false);
  const [profiles, setProfiles] = useState([DEFAULT_PROFILE]);
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE.id);
  const [starting, setStarting] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  useEffect(() => {
    if (!reviewReady) return;
    let mounted = true;
    fetch('/api/agents/review-profiles').then(r => r.ok ? r.json() : null).then(result => {
      if (mounted && Array.isArray(result?.profiles) && result.profiles.length) setProfiles(result.profiles);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [reviewReady]);

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const aRunning = !isTerminalStatus(a.status);
        const bRunning = !isTerminalStatus(b.status);
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        return b.startedAt - a.startedAt;
      }),
    [jobs],
  );
  const runningCount = jobs.filter((j) => !isTerminalStatus(j.status)).length;
  const launch = async (kind: 'opencode' | 'guide', reviewProfileId = profileId) => {
    if (starting || (kind === 'guide' ? !guideReady : !reviewReady)) return;
    setStarting(kind);
    setLaunchError(null);
    try {
      const job = await onLaunch({
        provider: kind,
        label: kind === 'guide' ? 'Guided Review' : 'Code Review',
        ...(kind === 'opencode' && reviewProfileId !== DEFAULT_PROFILE.id && { reviewProfileId }),
      });
      if (job === null) setLaunchError('OpenCode could not start the review.');
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : 'OpenCode could not start the review.');
    } finally {
      setStarting(null);
    }
  };

  const openJob = (job: AgentJobInfo, findings: readonly FindingLike[]) => {
    if (job.provider === 'guide') {
      if (job.status === 'done' && onOpenGuide && (canOpenGuideJob?.(job) ?? true)) onOpenGuide(job.id);
      else onOpenJobDetail?.(job.id);
      return;
    }
    if (job.status === 'done' && findings.length > 0 && onOpenFinding) onOpenFinding(findings[0]);
    else onOpenJobDetail?.(job.id);
  };

  return (
    <div className="flex flex-col pb-3" data-agents-tab="">
      <div className="space-y-2 px-4 py-3">
        {scope && <div data-launch-scope="">{scope}</div>}
        <div className="flex items-center justify-between gap-2" data-launch-row="guide">
          <span className="text-sm">Guided Review</span>
          <button type="button" disabled={!guideReady || starting !== null} onClick={() => void launch('guide')} data-launch-start="guide"
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
            {starting === 'guide' ? 'Starting…' : 'Start'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2" data-launch-row="review">
          <span className="text-sm">Review agent</span>
          <button type="button" disabled={!reviewReady || starting !== null} onClick={() => void launch('opencode')} data-launch-start="review"
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50">
            {starting === 'opencode' ? 'Starting…' : 'Start'}
          </button>
        </div>
        {reviewReady && <div className="flex items-center gap-2 text-xs">
          <select aria-label="Review profile" value={profileId} onChange={event => setProfileId(event.target.value)} className="min-w-0 rounded border border-border bg-background px-2 py-1">
            {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
          </select>
          <button type="button" onClick={() => setAddReviewOpen(true)} className="text-muted-foreground hover:text-foreground">Add review profile</button>
        </div>}
        {!reviewReady && <p className="text-xs text-muted-foreground">OpenCode V2 is unavailable.</p>}
        {launchError && <p role="alert" className="text-xs text-destructive">{launchError}</p>}
      </div>

      {sortedJobs.length > 0 && (
        <section aria-label="Runs" className="border-t border-border/60 mt-2">
          <SectionTitle
            trailing={
              runningCount >= 2 ? (
                <button
                  type="button"
                  onClick={onKillAll}
                  className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Square size={10} aria-hidden />
                  Cancel all ({runningCount})
                </button>
              ) : null
            }
          >
            Runs
          </SectionTitle>
          <div className="px-4">
            {sortedJobs.map((job) => {
              const findings = findingsOf(job.source, externalAnnotations);
              return (
                <JobRow
                  key={job.id}
                  job={job}
                  modelName={job.model ?? null}
                  findings={findings}
                  onOpen={() => openJob(job, findings)}
                  onDetails={onOpenJobDetail ? () => onOpenJobDetail(job.id) : undefined}
                  onCancel={() => onKillJob(job.id)}
                  onRerun={job.provider === 'guide'
                    ? () => void launch('guide')
                    : job.provider === 'opencode'
                      ? () => void launch('opencode', job.reviewProfileId ?? DEFAULT_PROFILE.id)
                      : undefined}
                />
              );
            })}
          </div>
        </section>
      )}

      {guides?.()}

      {addReviewOpen && (
        <AddReviewDialog
          onClose={() => setAddReviewOpen(false)}
          onEnabled={(name) => {
            const id = `skill:${name}`;
            setProfiles(prev => prev.some(p => p.id === id) ? prev : [...prev, { id, label: name }]);
            setProfileId(id);
            setAddReviewOpen(false);
          }}
        />
      )}
    </div>
  );
};
