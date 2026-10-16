import type {
  ReviewDiffLayout,
  ReviewDiffViewFactory,
  ReviewDiffViewSpec,
  ReviewDisposable,
} from "@dev.fast/review-protocol";
import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, type FileDiffOptions } from "@pierre/diffs/react";
import type { ShareDiffFileSummary, SharedReview } from "@review/sharing/read";
import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import type { WebTheme, WebThemeName } from "./highlight";
import type { Diffed } from "./structural/diffed";
import { createStructuralEngine } from "./structural/engine";
import {
  type StructuralFile,
  type StructuralView,
  createStructuralView,
} from "./structural/render";
import { diffStyles as styles } from "./web-styles";

type Review = Pick<SharedReview, "diff" | "text" | "snapshot">;

interface Entry {
  file: ShareDiffFileSummary;
  diff?: FileDiffMetadata;
  base?: string;
  head?: string;
}

export interface WebDiffViewOptions {
  structural?: { engineUrl: string; workerUrl?: string };
}

const fallbackLabels = new Map([
  ["too_complex", "Line diff · too complex"],
  ["parse_error", "Line diff · parse errors"],
  ["too_large", "Line diff · too large"],
  ["generated", "Line diff · generated"],
]);

const MAX_IN_FLIGHT = 8;

type Structural = { view: StructuralView } | { fallback: string };

function outcome(
  diffed: Diffed,
  file: StructuralFile,
  layout: ReviewDiffLayout,
  theme: WebThemeName,
): Structural | undefined {
  const { event } = diffed;

  if (event.error || event.diff?.type !== "text") return undefined;
  const fallback = event.diff.stats.fallback;

  if (fallback)
    return { fallback: fallbackLabels.get(fallback.code) ?? "Line diff" };

  try {
    const view = createStructuralView(diffed, file);
    view.render(layout, theme);

    return { view };
  } catch {
    return undefined;
  }
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
      base,
      head,
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

function StructuralDiff({
  view,
  layout,
  theme,
}: {
  view: StructuralView;
  layout: ReviewDiffLayout;
  theme: WebThemeName;
}) {
  const host = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => host.current?.replaceChildren(view.element), [view]);
  useLayoutEffect(() => view.render(layout, theme), [view, layout, theme]);

  return <div ref={host} />;
}

function DiffFiles({
  shown,
  files,
  missing,
  structural,
  options,
  tree,
  onReveal,
  onRendered,
}: {
  shown: Entry[];
  files: ShareDiffFileSummary[];
  missing: ReadonlySet<string>;
  structural: ReadonlyMap<string, Structural>;
  options: FileDiffOptions<undefined, undefined>;
  tree?: HTMLElement;
  onReveal(path: string): void;
  onRendered(): void;
}) {
  useLayoutEffect(onRendered, [onRendered]);

  return (
    <>
      {shown.map(({ file, diff }) => {
        const result = structural.get(file.path);
        const view = result && "view" in result ? result.view : undefined;

        const fallback =
          result && "fallback" in result ? result.fallback : undefined;

        return (
          <section
            key={file.path}
            data-diff-file={file.path}
            data-structural={view ? "" : undefined}
          >
            {view ? (
              <StructuralDiff
                view={view}
                layout={options.diffStyle === "split" ? "split" : "unified"}
                theme={options.themeType === "light" ? "light" : "dark"}
              />
            ) : diff ? (
              <FileDiff
                fileDiff={diff}
                options={options}
                renderHeaderFilenameSuffix={
                  fallback
                    ? () => (
                        <span {...stylex.props(styles.fallbackTag)}>
                          {fallback}
                        </span>
                      )
                    : undefined
                }
              />
            ) : (
              <div {...stylex.props(styles.binary)}>
                {file.path} · Binary file
              </div>
            )}
          </section>
        );
      })}
      {tree &&
        createPortal(
          <ul {...stylex.props(styles.tree)}>
            {files.map((file) => (
              <li key={file.path}>
                {missing.has(file.path) ? (
                  <div
                    {...stylex.props(styles.treeItem, styles.treeMissing)}
                    data-missing-file=""
                  >
                    <span {...stylex.props(styles.treePath)}>{file.path}</span>
                    <span {...stylex.props(styles.treeCounts)}>
                      Not included in this share
                    </span>
                  </div>
                ) : (
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
                )}
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
  onDidChangeLayout: (
    listener: (layout: ReviewDiffLayout) => void,
  ) => ReviewDisposable,
  theme: WebTheme,
  options: WebDiffViewOptions = {},
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
      const missingPaths = new Set(missing);
      let diffLayout = layout();
      let rendered = false;
      let pending: string | undefined;
      let disposed = false;

      const engine = options.structural
        ? createStructuralEngine(options.structural)
        : undefined;

      const structural = new Map<string, Structural>();
      const byPath = new Map(shown.map((entry) => [entry.file.path, entry]));
      const waiting: Entry[] = [];
      let inFlight = 0;

      const pump = () => {
        while (engine && inFlight < MAX_IN_FLIGHT && waiting.length) {
          const { file, base, head } = waiting.shift()!;
          inFlight++;
          void engine
            .diff(
              file.status,
              base === undefined
                ? undefined
                : { path: file.previousPath ?? file.path, text: base },
              head === undefined ? undefined : { path: file.path, text: head },
            )
            .then(
              (diffed) => outcome(diffed, file, diffLayout, theme.theme()),
              () => undefined,
            )
            .then((result) => {
              inFlight--;

              if (disposed) return;

              if (result !== undefined) {
                structural.set(file.path, result);
                render();
              }

              pump();
            });
        }
      };

      const observer = engine
        ? new IntersectionObserver(
            (records) => {
              for (const record of records) {
                if (!record.isIntersecting) continue;
                observer!.unobserve(record.target);

                const entry = byPath.get(
                  record.target.getAttribute("data-diff-file") ?? "",
                );

                if (entry?.diff) waiting.push(entry);
              }

              pump();
            },
            { root: scroller, rootMargin: "1200px" },
          )
        : undefined;

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

      const render = () =>
        root.render(
          <DiffFiles
            shown={shown}
            files={files}
            missing={missingPaths}
            structural={structural}
            tree={spec.fileTreeContainer}
            options={{
              diffStyle: diffLayout === "split" ? "split" : "unified",
              theme: { dark: "pierre-dark", light: "pierre-light" },
              themeType: theme.theme(),
            }}
            onReveal={revealFile}
            onRendered={onRendered}
          />,
        );

      const onRendered = () => {
        rendered = true;

        for (const element of scroller.querySelectorAll("[data-diff-file]"))
          observer?.observe(element);

        if (pending !== undefined) revealFile(pending);
        pending = undefined;
      };

      render();

      for (const subscription of [
        onDidChangeLayout((next) => {
          diffLayout = next;
          render();
        }),
        theme.onDidChangeTheme(render),
      ])
        disposables.push(() => subscription.dispose());

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
        onDidError(listener) {
          errorListeners.add(listener);

          return { dispose: () => errorListeners.delete(listener) };
        },
        dispose() {
          if (disposed) return;
          disposed = true;

          for (const dispose of disposables.splice(0)) dispose();
          observer?.disconnect();
          engine?.dispose();
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
