import { defineRequestHostScenarios } from "./request-host.scenarios";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";

const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";

defineRequestHostScenarios("bun", async (kind, { docPath, htmlContent }) => {
  if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n\nsecret body\n", filePath: docPath, htmlContent });
});
