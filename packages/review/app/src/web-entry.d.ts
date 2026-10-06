import type { ShareBundle, SharedReview } from "@dev.fast/whiteboard/sharing";

export type { ShareBundle, SharedReview };

export interface MountSharedReviewOptions {
  wasmUrl: string;
  theme: "dark" | "light";
  onDidChangeTheme?: (listener: (theme: "dark" | "light") => void) => {
    dispose(): void;
  };
}

export interface ReviewCanvasHandle {
  focus(): void;
  showFind(seed?: string): boolean;
  dispose(): void;
}

export function mountSharedReview(
  container: HTMLElement,
  bundle: ShareBundle,
  options: MountSharedReviewOptions,
): ReviewCanvasHandle;

export function readSharedReview(bundle: ShareBundle): SharedReview;
