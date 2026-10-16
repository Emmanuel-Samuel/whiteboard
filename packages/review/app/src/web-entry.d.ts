import type { ShareBundle, SharedReview } from "@dev.fast/whiteboard/sharing";

export type { ShareBundle, SharedReview };

export interface ReviewMenuItem {
  id: string;
  label: string;
  enabled?: boolean;
  checked?: boolean;
}

export interface ReviewMenuRequest {
  anchor: HTMLElement;
  items: readonly ReviewMenuItem[];
  onSelect(id: string): void | Promise<void>;
  onHide(): void;
}

export interface ReviewCanvasUi {
  confirmDelete?(titles: readonly string[]): Promise<boolean>;
  showMenu(request: ReviewMenuRequest): { dispose(): void };
}

export interface MountSharedReviewOptions {
  wasmUrl: string;
  theme: "dark" | "light";
  onDidChangeTheme?: (listener: (theme: "dark" | "light") => void) => {
    dispose(): void;
  };
  ui?: ReviewCanvasUi;
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
