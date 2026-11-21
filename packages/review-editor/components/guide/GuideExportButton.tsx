import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

interface ExportInfo {
  bytes: number;
  filename: string;
}

export function useGuideExportInfo(jobId: string, enabled = true) {
  const encoded = encodeURIComponent(jobId);
  const [result, setResult] = useState<{ encoded: string; info: ExportInfo } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch(`/api/guide/${encoded}/export-info`, { signal: controller.signal })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!controller.signal.aborted && typeof data?.filename === 'string' && Number.isFinite(data.bytes)) {
          setResult({ encoded, info: { bytes: data.bytes, filename: data.filename } });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [encoded, enabled]);

  return { info: enabled && result?.encoded === encoded ? result.info : null, encoded };
}

export const GuideExportButton: React.FC<{ jobId: string }> = ({ jobId }) => {
  const { info, encoded } = useGuideExportInfo(jobId);
  if (!info) return null;
  return (
    <a
      href={`/api/guide/${encoded}/export`}
      download={info.filename}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      data-testid="guide-export"
    >
      <Download size={13} /> Download portable guide
    </a>
  );
};
