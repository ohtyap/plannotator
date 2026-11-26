import React from 'react';
import { Button } from '@plannotator/ui/components/ui/button';

export function FolderAnnotationEmptyState({
  onChooseFile,
}: {
  onChooseFile: () => void;
}) {
  return (
    <div className="w-full flex justify-center">
      <div className="w-full max-w-3xl p-12 text-center text-muted-foreground">
        <p className="text-lg font-medium mb-2">Select a file to annotate</p>
        <p className="text-sm">
          Choose a Markdown, text, HTML, or diagram file to begin.
        </p>
        <Button type="button" variant="secondary" size="sm" className="mt-4" aria-haspopup="dialog" onClick={onChooseFile}>
          Choose a file
        </Button>
      </div>
    </div>
  );
}
