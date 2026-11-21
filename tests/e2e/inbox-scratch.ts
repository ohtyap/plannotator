// Compatibility names for existing review and annotate browser tests.
// No Inbox is started, queried, registered, or signalled by this helper.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_LAUNCH_OFF = {};
const roots = new Set<string>();

export function inboxScratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.add(dir);
  return dir;
}

export async function removeInboxScratch(root?: string): Promise<void> {
  for (const path of root ? [root] : [...roots]) {
    if (!roots.delete(path)) continue;
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
