import { readFileSync } from "node:fs";

// Bun embeds the built pages into the executable. Import as files to keep
// their original encoding rather than expanding non-ASCII pages to UTF-16.
// @ts-ignore - Bun file import
import annotatePath from "../dist/index.html" with { type: "file" };
// @ts-ignore - Bun file import
import reviewPath from "../dist/review.html" with { type: "file" };

export const annotatePage = () => readFileSync(annotatePath as unknown as string, "utf8");
export const reviewPage = () => readFileSync(reviewPath as unknown as string, "utf8");
