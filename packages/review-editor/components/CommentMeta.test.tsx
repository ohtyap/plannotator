import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setAnnotationIdentityEnabled } from '@plannotator/ui/utils/annotationIdentityPolicy';
import { CommentMeta } from './CommentMeta';

test('single-user review hides a stored author without hiding the source or time', () => {
  const createdAt = Date.now() - 2 * 60_000;
  const row = <CommentMeta author="Old reviewer name" source="Review agent" createdAt={createdAt} />;
  const attributed = renderToStaticMarkup(row);
  expect(attributed).toContain('Old reviewer name');

  setAnnotationIdentityEnabled(false);
  try {
    const anonymous = renderToStaticMarkup(row);
    expect(anonymous).not.toContain('Old reviewer name');
    expect(anonymous).not.toContain('(me)');
    expect(anonymous).toContain('Review agent');
    expect(anonymous).toContain('2m');
  } finally {
    setAnnotationIdentityEnabled(true);
  }
});
