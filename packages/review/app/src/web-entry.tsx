import type {
  ReviewCanvasBridge,
  ReviewCanvasHandle,
  ReviewCanvasUi,
  ReviewDisposable,
} from "@dev.fast/review-protocol";
import type { ShareBundle } from "@review/sharing/export";
import { readSharedReview } from "@review/sharing/read";

import { mountReviewCanvas } from "./desktop-entry";
import { createWebDiffView } from "./web/diff-view";
import { createWebInlineEditors } from "./web/inline-editors";
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
  ui?: ReviewCanvasUi;
}

export function mountSharedReview(
  container: HTMLElement,
  bundle: ShareBundle,
  options: MountSharedReviewOptions,
): ReviewCanvasHandle {
  const { ui, ...bridgeOptions } = options;
  const review = readSharedReview(bundle);

  const bridge: ReviewCanvasBridge = createShareBridge(review, {
    ...bridgeOptions,
    inlineEditors: createWebInlineEditors(review),
    diffView: createWebDiffView(
      review,
      () => bridge.currentDiffLayout(),
      (listener) => bridge.onDidChangeDiffLayout(listener),
    ),
  });

  return mountReviewCanvas(
    container,
    {
      kind: "api",
      reviewId: review.snapshot.reviewId,
      version: review.snapshot.version,
      bridge,
    },
    ui,
  );
}
