let enabled = true;

/** Set at app startup. Reusable hosts keep author attribution by default. */
export function setAnnotationIdentityEnabled(value: boolean): void {
  enabled = value;
}

export function annotationIdentityEnabled(): boolean {
  return enabled;
}

export function visibleAnnotationAuthor(author?: string): string | undefined {
  return enabled ? author : undefined;
}
