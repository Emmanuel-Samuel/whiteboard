import type {
  ReviewDiffLayout,
  ReviewDiffViewFactory,
  ReviewDiffViewSpec,
} from "@dev.fast/review-protocol";
import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import type { ShareDiffFileSummary, SharedReview } from "@review/sharing/read";
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { currentTheme } from "./highlight";
import { diffStyles as styles } from "./web-styles";

type Review = Pick<SharedReview, "diff" | "text" | "snapshot">;

interface Entry {
  file: ShareDiffFileSummary;
  diff?: FileDiffMetadata;
}

function entries(review: Review, files: ShareDiffFileSummary[]) {
  const pins = review.snapshot.pins;
  const shown: Entry[] = [];
  const missing: string[] = [];

  for (const file of files) {
    if (file.binary) {
      shown.push({ file });
      continue;
    }

    const base =
      file.status === "added" || !pins
        ? undefined
        : review.text(file.previousPath ?? file.path, pins.base);

    const head =
      file.status === "deleted" || !pins
        ? undefined
        : review.text(file.path, pins.head);

    if (
      (file.status !== "added" && base === undefined) ||
      (file.status !== "deleted" && head === undefined)
    ) {
      missing.push(file.path);
      continue;
    }

    shown.push({
      file,
      diff: parseDiffFromFile(
        base === undefined
          ? null
          : { name: file.previousPath ?? file.path, contents: base },
        head === undefined ? null : { name: file.path, contents: head },
      ),
    });
  }

  return { shown, missing };
}

function DiffFiles({
  shown,
  files,
  options,
  tree,
  onReveal,
  onRendered,
}: {
  shown: Entry[];
  files: ShareDiffFileSummary[];
  options: FileDiffOptions<undefined, undefined>;
  tree?: HTMLElement;
  onReveal(path: string): void;
  onRendered(): void;
}) {
  useLayoutEffect(onRendered, [onRendered]);

  return (
    <>
      {shown.map(({ file, diff }) => (
        <section key={file.path} data-diff-file={file.path}>
          {diff ? (
            <FileDiff fileDiff={diff} options={options} />
          ) : (
            <div {...stylex.props(styles.binary)}>
              {file.path} · Binary file
            </div>
          )}
        </section>
      ))}
      {tree &&
        createPortal(
          <ul {...stylex.props(styles.tree)}>
            {files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  {...stylex.props(styles.treeItem)}
                  onClick={() => onReveal(file.path)}
                >
                  <span {...stylex.props(styles.treePath)}>{file.path}</span>
                  <span {...stylex.props(styles.treeCounts)}>
                    +{file.additions} −{file.deletions}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          tree,
        )}
    </>
  );
}

export function createWebDiffView(
  review: Review,
  layout: () => ReviewDiffLayout,
): ReviewDiffViewFactory {
  return {
    files: async () => review.diff(),
    create(spec: ReviewDiffViewSpec) {
      const scroller = document.createElement("div");
      const { className, style } = stylex.props(styles.scroller);
      scroller.className = className ?? "";

      if (style) Object.assign(scroller.style, style);
      scroller.tabIndex = -1;
      spec.container.append(scroller);

      const errorListeners = new Set<(message: string) => void>();
      const disposables: (() => void)[] = [];
      const root = createRoot(scroller);
      const files = review.diff();
      const { shown, missing } = entries(review, files);
      let rendered = false;
      let pending: string | undefined;
      let disposed = false;

      const section = (path: string) =>
        [...scroller.querySelectorAll<HTMLElement>("[data-diff-file]")].find(
          (element) => element.dataset.diffFile === path,
        );

      const revealFile = (path: string) => {
        if (!rendered) {
          pending = path;

          return;
        }

        section(path)?.scrollIntoView({ block: "start" });
      };

      root.render(
        <DiffFiles
          shown={shown}
          files={files}
          tree={spec.fileTreeContainer}
          options={{
            diffStyle: layout() === "split" ? "split" : "unified",
            theme: { dark: "pierre-dark", light: "pierre-light" },
            themeType: currentTheme(),
          }}
          onReveal={revealFile}
          onRendered={() => {
            rendered = true;

            if (pending !== undefined) revealFile(pending);
            pending = undefined;
          }}
        />,
      );

      if (missing.length) {
        const timer = setTimeout(() => {
          const message = `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not included in this share.`;

          for (const listener of errorListeners) listener(message);
        });

        disposables.push(() => clearTimeout(timer));
      }

      return {
        focus: () => scroller.focus(),
        setProgress() {},
        revealFile,
        revealSource: (source) => revealFile(source.file),
        sourceOffset(source) {
          const element = section(source.file);

          return element
            ? element.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top
            : undefined;
        },
        onDidError(listener) {
          errorListeners.add(listener);

          return { dispose: () => errorListeners.delete(listener) };
        },
        onDidScroll(listener) {
          const onScroll = () => listener({ height: scroller.clientHeight });
          scroller.addEventListener("scroll", onScroll);

          const dispose = () =>
            scroller.removeEventListener("scroll", onScroll);

          disposables.push(dispose);

          return { dispose };
        },
        dispose() {
          if (disposed) return;
          disposed = true;

          for (const dispose of disposables.splice(0)) dispose();
          errorListeners.clear();
          setTimeout(() => {
            root.unmount();
            scroller.remove();
          });
        },
      };
    },
  };
}
