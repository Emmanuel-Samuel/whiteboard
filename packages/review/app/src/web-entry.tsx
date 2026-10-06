import type {
  ReviewCanvasHandle,
  ReviewDisposable,
} from "@dev.fast/review-protocol";
import type { ShareBundle } from "@review/sharing/export";
import { readSharedReview } from "@review/sharing/read";

import { mountReviewCanvas } from "./desktop-entry";
import {
  placeholderDiffView,
  placeholderInlineEditors,
} from "./web/placeholders";
import { createShareBridge } from "./web/share-bridge";

import "./styles.css";

export { readSharedReview };

export type { ShareBundle };

export type { SharedReview } from "@review/sharing/read";

export interface MountSharedReviewOptions {
  wasmUrl: string;
  theme: "dark" | "light";
  onDidChangeTheme?: (
    listener: (theme: "dark" | "light") => void,
  ) => ReviewDisposable;
}

export function mountSharedReview(
  container: HTMLElement,
  bundle: ShareBundle,
  options: MountSharedReviewOptions,
): ReviewCanvasHandle {
  const review = readSharedReview(bundle);

  const bridge = createShareBridge(review, {
    ...options,
    inlineEditors: placeholderInlineEditors(),
    diffView: placeholderDiffView(),
  });

  return mountReviewCanvas(container, {
    kind: "api",
    reviewId: review.snapshot.reviewId,
    version: review.snapshot.version,
    bridge,
  });
}
