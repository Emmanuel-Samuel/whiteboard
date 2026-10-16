import type {
  ReviewCanvasHandle,
  ReviewCanvasUi,
  ReviewDisposable,
} from "@dev.fast/review-protocol";
import type { ShareBundle } from "@review/sharing/export";
import { readSharedReview } from "@review/sharing/read";

import { mountReviewCanvas } from "./desktop-entry";
import { createWebDiffView } from "./web/diff-view";
import type { WebTheme } from "./web/highlight";
import { createWebInlineEditors } from "./web/inline-editors";
import { webCanvasUi } from "./web/menu";
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

  const theme: WebTheme = {
    theme: () => bridge.currentTheme(),
    onDidChangeTheme: (listener) => bridge.onDidChangeTheme(listener),
  };

  const bridge = createShareBridge(review, {
    ...bridgeOptions,
    inlineEditors: createWebInlineEditors(review, theme),
    diffView: createWebDiffView(
      review,
      () => bridge.currentDiffLayout("diff"),
      (listener) => bridge.onDidChangeDiffLayout("diff", listener),
      theme,
    ),
  });

  const handle = mountReviewCanvas(
    container,
    {
      kind: "api",
      reviewId: bridge.config.reviewId,
      available: { sourceWindows: false },
      bridge,
    },
    ui ?? webCanvasUi(),
  );

  return {
    ...handle,
    dispose() {
      handle.dispose();
      bridge.dispose();
    },
  };
}
