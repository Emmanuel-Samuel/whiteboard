/**
 * The comparison: every file as plain rows the browser scrolls, selects and finds in natively,
 * unified or split. diffr's folds are the session's: a collapsed region leaves a band (with its
 * pseudocode, for a summary) or folds into its header line, and a line that heads a fold carries
 * its chevron. On a phone every fold control is the full row or band, for a thumb; on a desktop the
 * gutter folds, so a click in the code is free to select, and the file tree sits beside the list.
 */
import { Emitter } from "vs/base/common/event.js";
import { Disposable, toDisposable } from "vs/base/common/lifecycle.js";
import { type IObservable, autorun } from "vs/base/common/observable.js";
import type { URI } from "vs/base/common/uri.js";
import {
  FontStyle,
  TokenMetadata,
} from "vs/editor/common/encodedTokenAttributes.js";
import type { IInstantiationService } from "vs/platform/instantiation/common/instantiation.js";

import { showLineNumbers } from "./display.js";

import "./diffView.css";
import { FilesSidebar } from "./filesSidebar.js";
import { nestedIds } from "./folds.js";
import type {
  ReviewDiffFileWire,
  ReviewDiffProgress,
  ReviewDiffProgressFile,
} from "./protocol.js";
import { ReviewViewedCheckbox } from "./review/browser/reviewTooltip.js";
import {
  type SplitCell,
  type SplitItem,
  type UnifiedBand,
  type UnifiedItem,
  type UnifiedLine,
  sourceLines,
  splitItems,
  unifiedItems,
} from "./review/common/reviewDiffRows.js";
import {
  type ReviewFileCounts,
  type StructuralFoldable,
  type StructuralSource,
  type StructuralSyntaxSpan,
  type StructuralTextDiff,
  binarySizeLabel,
  isBinaryCounts,
  structuralFoldables,
  structuralHighlights,
  utf16Column,
} from "./review/common/reviewStructuralDiff.js";
import {
  SYNTAX_SCOPES,
  type SyntaxRole,
  syntaxRole,
} from "./review/common/reviewSyntaxRoles.js";
import type { ReviewDiffLayoutSetting } from "./review/services/reviewDiffLayout.js";
import type { StructuralDiffSession } from "./review/services/reviewStructuralDiffSession.js";
import type { StructuralViewedState } from "./review/services/reviewStructuralViewed.js";
import { StandaloneServices } from "./standalone/browser/standaloneServices.js";
import { IStandaloneThemeService } from "./standalone/common/standaloneTheme.js";
import { element } from "./ui.js";
import { mobileViewport } from "./viewport.js";

/** Rows per block the browser may skip laying out while it is off screen. */
const CHUNK = 120;

/** Characters of a line drawn, as the desktop editor stops rendering past them. */
const MAX_LINE = 10_000;

/** A file's body is built within this distance of the screen and released past the second. */
const BUILD_MARGIN = "150% 0px";

const RELEASE_MARGIN = "600% 0px";

/** Rows an undrawn file's placeholder is tall. */
const PLACEHOLDER_ROWS = 12;

const LOADING = "Loading diff…";

/** What drawing a file's lines reads: each side's text, syntax and changed spans by line. */
interface RowContext {
  readonly text: Record<"lhs" | "rhs", string[]>;
  readonly syntax: Record<"lhs" | "rhs", Map<number, StructuralSyntaxSpan[]>>;
  readonly changed: Record<"lhs" | "rhs", Map<number, [number, number][]>>;
  readonly path: string;
  /** Lines the reader has viewed, from 0; empty sets when none are. */
  readonly viewed: Record<"lhs" | "rhs", Set<number>>;
  /** Header lines of viewed scopes that keep their viewed control in view. */
  readonly viewedHeads: Record<"lhs" | "rhs", Set<number>>;
}

/** A scope on one side of a file: the fold a row heads, or the smallest open one around it. */
interface Scope {
  readonly path: string;
  readonly side: "lhs" | "rhs";
  readonly foldable: StructuralFoldable;
  readonly collapsed: boolean;
}

/** One find match, as find.ts counts: 1-based line and column. */
export interface FindMatch {
  path: string;
  side: "original" | "modified";
  line: number;
  column: number;
  length: number;
}

interface FileView {
  readonly entry: DiffEntry;
  readonly section: HTMLElement;
  readonly header: HTMLElement;
  readonly name: HTMLElement;
  readonly note: HTMLElement;
  readonly countsNode: HTMLElement;
  readonly viewed: ReviewViewedCheckbox;
  readonly body: HTMLElement;
  /** Why the file has no diff to show yet, or ever. */
  state: string | undefined;
  collapsed: boolean;
  /** The reader or a lens folded it; a hidden file's own fold waits until then. */
  collapseSet: boolean;
  hidden?: string;
  counts?: ReviewFileCounts;
  progress?: ReviewDiffProgressFile;
  viewedApplied?: string;
  /** Its body is drawn; otherwise a placeholder holds its last height. */
  built: boolean;
  near: boolean;
  /** How far each side of the split view is scrolled sideways, kept across its segments. */
  readonly scrolled: { lhs: number; rhs: number };
  /** Its body's blocks of rows, while it is drawn. */
  chunks: Chunk[];
  /** The viewed lines it was drawn with, to redraw when they change. */
  viewedKey?: string;
}

/** One changed file of the comparison. */
export interface DiffEntry {
  readonly file: ReviewDiffFileWire;
  /** Where its header's link opens the file. */
  readonly goToFileResource: URI;
}

/** A block of a file's rows, drawn only near the screen. */
interface Chunk {
  readonly element: HTMLElement;
  readonly file: FileView;
  /** The first and last line it holds on each side. */
  readonly lines: Record<"lhs" | "rhs", [number, number] | undefined>;
  /** Whether a run of changes starts in it. */
  readonly changes: boolean;
  built: boolean;
  readonly draw: (into: HTMLElement) => void;
}

export class DiffView extends Disposable {
  private readonly _onDidScroll = this._register(new Emitter<void>());
  /** The list scrolled or its topmost file changed. */
  readonly onDidScroll = this._onDidScroll.event;
  private readonly _onDidRequestFile = this._register(new Emitter<string>());
  /** A file still waiting came on screen, or the reader picked it in the tree. */
  readonly onDidRequestFile = this._onDidRequestFile.event;

  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly sidebar: FilesSidebar;
  private sidebarHidden = false;
  /** Drawn for a phone: unified, with every fold control a thumb's size. */
  private compact = mobileViewport.matches;
  private split: boolean;
  private wrapped = false;
  private readonly status: HTMLElement;
  private readonly files = new Map<string, FileView>();
  private readonly bySection = new WeakMap<Element, FileView>();
  private order: FileView[] = [];
  private progress: ReviewDiffProgress | undefined;
  private readonly build: IntersectionObserver;
  private readonly release: IntersectionObserver;
  private readonly chunkBuild: IntersectionObserver;
  private readonly chunkRelease: IntersectionObserver;
  private readonly chunkOf = new WeakMap<Element, Chunk>();
  private readonly request: IntersectionObserver;
  private scrollFrame = 0;
  /** A selection when the press began: the tap ends it, and must not fold anything. */
  private pressedOverSelection = false;
  private find: { matches: FindMatch[]; current: number } | undefined;
  private reveal: { cancel(): void } | undefined;

  constructor(
    container: HTMLElement,
    private readonly session: StructuralDiffSession,
    private readonly onToggleViewed: (path: string) => void,
    private readonly scopes: StructuralViewedState,
    wordWrap: IObservable<boolean>,
    private readonly layout: ReviewDiffLayoutSetting,
    instantiation: IInstantiationService,
  ) {
    super();
    this.host = container.appendChild(element("div", "dv-host"));
    this.sidebar = this._register(new FilesSidebar(instantiation));
    this.host.append(this.sidebar.element);
    this.root = this.host.appendChild(element("div", "dv"));
    this.root.tabIndex = -1;
    this.status = this.root.appendChild(element("div", "dv-status"));
    this.status.setAttribute("role", "status");
    this.split = this.wantsSplit();
    this.applyScreen();
    this._register(toDisposable(() => this.host.remove()));

    this._register(
      this.sidebar.onDidOpenFile((path) => {
        this._onDidRequestFile.fire(path);
        this.revealFile(path);
      }),
    );
    this._register(
      this.onDidScroll(() => this.sidebar.setActiveFile(this.activePath)),
    );

    const screen = () => {
      this.compact = mobileViewport.matches;
      this.applyScreen();
      this.relayout();
    };

    mobileViewport.addEventListener("change", screen);
    this._register(
      toDisposable(() => mobileViewport.removeEventListener("change", screen)),
    );
    this._register(layout.onDidChange(() => this.relayout()));

    this.build = new IntersectionObserver(
      (entries) => this.preserve(() => this.onBuild(entries)),
      { root: this.root, rootMargin: BUILD_MARGIN },
    );
    this.release = new IntersectionObserver(
      (entries) => this.onRelease(entries),
      { root: this.root, rootMargin: RELEASE_MARGIN },
    );
    this.chunkBuild = new IntersectionObserver(
      (entries) =>
        this.preserve(() => {
          for (const entry of entries) {
            const chunk = this.chunkOf.get(entry.target);

            if (entry.isIntersecting && chunk) this.fillChunk(chunk);
          }
        }),
      { root: this.root, rootMargin: BUILD_MARGIN },
    );
    this.chunkRelease = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const chunk = this.chunkOf.get(entry.target);

          if (!entry.isIntersecting && chunk) this.emptyChunk(chunk);
        }
      },
      { root: this.root, rootMargin: RELEASE_MARGIN },
    );
    this.request = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const file = this.bySection.get(entry.target);

          if (entry.isIntersecting && file?.state === LOADING)
            this._onDidRequestFile.fire(file.entry.file.path);
        }
      },
      { root: this.root },
    );
    this._register(
      toDisposable(() => {
        this.build.disconnect();
        this.release.disconnect();
        this.chunkBuild.disconnect();
        this.chunkRelease.disconnect();
        this.request.disconnect();
        this.reveal?.cancel();
        cancelAnimationFrame(this.scrollFrame);

        for (const file of this.files.values()) file.viewed.dispose();
        CSS.highlights?.delete("diffr-find");
        CSS.highlights?.delete("diffr-find-current");
      }),
    );

    this.root.addEventListener(
      "scroll",
      () => {
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
          this.scrollFrame = 0;
          this._onDidScroll.fire();
        });
      },
      { passive: true },
    );
    this.root.addEventListener(
      "pointerdown",
      (event) => {
        this.pressedOverSelection = !(
          window.getSelection()?.isCollapsed ?? true
        );
        this.reveal?.cancel();

        // A selection stays on the side it starts on, as each side reads on its own.
        const side =
          event.target instanceof Element &&
          event.target.closest<HTMLElement>("[data-side]")?.dataset.side;

        if (side) this.root.dataset.selecting = side;
      },
      { passive: true },
    );
    // Each side of a split file scrolls sideways as one, across the bands that break it up.
    this.root.addEventListener(
      "scroll",
      (event) => {
        const pane = event.target;

        if (!(pane instanceof HTMLElement) || !pane.matches(".dv-pane")) return;
        // SAFETY: renderSplit gives every pane a side of "lhs" or "rhs".
        const side = pane.dataset.side as "lhs" | "rhs";
        const file = this.bySection.get(pane.closest(".dv-file")!);

        if (!file || file.scrolled[side] === pane.scrollLeft) return;
        file.scrolled[side] = pane.scrollLeft;

        for (const other of file.body.querySelectorAll<HTMLElement>(
          `.dv-pane[data-side="${side}"]`,
        ))
          if (other !== pane) other.scrollLeft = pane.scrollLeft;
      },
      { capture: true, passive: true },
    );
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.listenForScopes();
    this.root.addEventListener("keydown", (event) => {
      if (
        (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLElement &&
        event.target.matches(".dv-band")
      ) {
        event.preventDefault();
        this.onClick(event);
      }
    });

    const resize = new ResizeObserver(() =>
      this.root.style.setProperty("--dv-width", `${this.root.clientWidth}px`),
    );

    resize.observe(this.root);
    this._register(toDisposable(() => resize.disconnect()));

    this._register(
      autorun((reader) => {
        this.wrapped = wordWrap.read(reader);
        this.root.classList.toggle("is-wrapped", this.wrapped);

        // Split, a wrapped file is one grid and an unwrapped one two panes: it is drawn again.
        if (this.split) this.relayout();
      }),
    );
    this._register(
      autorun((reader) =>
        this.root.classList.toggle("no-numbers", !showLineNumbers.read(reader)),
      ),
    );

    const themes = StandaloneServices.get(IStandaloneThemeService);
    const paint = () => this.paintSyntax(themes);
    this._register(themes.onDidColorThemeChange(paint));
    paint();

    this._register(
      session.onDidChange((change) =>
        this.preserve(() => {
          for (const path of change.files) {
            const file = this.files.get(path);

            if (file?.built) this.renderBody(file);
          }
        }),
      ),
    );
    this._register(this.scopes.onDidChange(() => this.syncViewed()));
  }

  /** The theme's colour for each of diffr's syntax roles, as CSS variables. */
  private paintSyntax(
    themes: ReturnType<typeof StandaloneServices.get<IStandaloneThemeService>>,
  ): void {
    const tokens = themes.getColorTheme().tokenTheme;
    const colors = tokens.getColorMap();

    for (const [role, scope] of Object.entries(SYNTAX_SCOPES)) {
      const metadata = tokens.match(0, scope);
      const color = colors[TokenMetadata.getForeground(metadata)];
      this.root.style.setProperty(`--dv-${role}`, color?.toString() ?? "");
      this.root.style.setProperty(
        `--dv-${role}-style`,
        TokenMetadata.getFontStyle(metadata) & FontStyle.Italic
          ? "italic"
          : "normal",
      );
    }
  }

  /** Split as the setting says, except on a phone, which has no room for two sides. */
  private wantsSplit(): boolean {
    return !this.compact && this.layout.get() === "split";
  }

  private applyScreen(): void {
    this.root.classList.toggle("is-compact", this.compact);
    this.sidebar.hidden = this.compact || this.sidebarHidden;
  }

  /** Draw the drawn files again, for a new layout, keeping the reader's row in place. */
  private relayout(): void {
    const split = this.wantsSplit();
    const changed = split !== this.split;
    this.split = split;

    if (!changed && !split) return;
    this.preserve(() => {
      for (const file of this.order) if (file.built) this.renderBody(file);
    });
  }

  startLoading(entries: readonly DiffEntry[]): void {
    this.sidebar.setFiles(
      Array.from(
        new Map(entries.map((entry) => [entry.file.path, entry.file])).values(),
      ),
    );

    for (const entry of entries)
      this.sidebar.setFileState(entry.file.path, "loading");

    for (const entry of entries) {
      if (this.files.has(entry.file.path)) continue;
      const file = this.createFile(entry);
      this.files.set(entry.file.path, file);
      this.bySection.set(file.section, file);
      this.order.push(file);
      this.root.append(file.section);
      this.build.observe(file.section);
      this.release.observe(file.section);
      this.request.observe(file.section);
    }

    this.showStatus();
  }

  private createFile(entry: DiffEntry): FileView {
    const path = entry.file.path;
    const section = element("section", "dv-file");
    section.dataset.path = path;
    const header = section.appendChild(element("header", "dv-header"));
    header.setAttribute("role", "button");
    header.tabIndex = 0;
    const title = header.appendChild(element("span", "dv-header-title"));
    const at = path.lastIndexOf("/");
    const name = title.appendChild(element("span", "dv-header-path"));

    if (at >= 0)
      name.append(element("span", "dv-header-dir", path.slice(0, at + 1)));
    name.append(element("span", "dv-header-name", path.slice(at + 1)));

    if (entry.file.previousPath)
      name.title = `${entry.file.previousPath} → ${path}`;
    const note = title.appendChild(element("span", "dv-header-note"));

    const countsNode = header.appendChild(element("span", "dv-header-counts"));

    const viewed = new ReviewViewedCheckbox(document, () =>
      this.onToggleViewed(path),
    );

    const open = header.appendChild(
      element("a", "dv-open codicon codicon-link-external"),
    );

    open.href = entry.goToFileResource.toString(true);
    open.target = "_blank";
    open.rel = "noopener";
    open.title = "Open file on GitHub";
    open.setAttribute("aria-label", `Open ${path} on GitHub`);
    header.append(viewed.element);
    const body = section.appendChild(element("div", "dv-body"));

    const file: FileView = {
      entry,
      section,
      header,
      name,
      note,
      countsNode,
      viewed,
      body,
      state: LOADING,
      collapsed: false,
      collapseSet: false,
      built: false,
      near: false,
      scrolled: { lhs: 0, rhs: 0 },
      chunks: [],
    };

    this.renderHeader(file);
    this.renderBody(file);

    return file;
  }

  fileLoaded(path: string, error?: string): void {
    const file = this.files.get(path);

    if (!file) return;
    file.state = error;
    this.sidebar.setFileState(path, error ? "error" : undefined, error);
    this.preserve(() => {
      this.applyViewed(file);
      this.renderHeader(file);
      this.renderBody(file);
    });
    this.showStatus();
    this.applyFind();
  }

  loadingFailed(message: string): void {
    for (const file of this.files.values())
      if (file.state === LOADING)
        this.fileLoaded(file.entry.file.path, message);
    this.showStatus();
  }

  /** A file diffr hides by default (generated, vendored), and why. */
  hideFile(path: string, label: string): void {
    const file = this.files.get(path);

    if (!file) return;
    file.hidden = label;

    if (!file.collapseSet) file.collapsed = true;
    this.preserve(() => {
      this.renderHeader(file);
      this.renderBody(file);
    });
  }

  fileCounts(path: string, counts: ReviewFileCounts): void {
    const file = this.files.get(path);

    if (!file) return;
    file.counts = counts;
    this.sidebar.setCounts(path, counts);
    this.renderHeader(file);
  }

  setFileCollapsed(path: string, collapsed: boolean): void {
    const file = this.files.get(path);

    if (!file) return;
    file.collapseSet = true;

    if (file.collapsed === collapsed) return;
    file.collapsed = collapsed;
    this.preserve(() => {
      this.renderHeader(file);
      this.renderBody(file);
    });
  }

  listOnly(paths: ReadonlySet<string> | undefined): void {
    this.sidebar.listOnly(paths);

    for (const file of this.order)
      file.section.hidden = !!paths && !paths.has(file.entry.file.path);
  }

  setProgress(progress: ReviewDiffProgress): void {
    this.progress = progress;
    this.sidebar.setProgress(progress);
    this.preserve(() => {
      for (const file of this.order) {
        file.progress = progress.files.find(
          (candidate) => candidate.path === file.entry.file.path,
        );
        this.applyViewed(file);
        this.renderHeader(file);
      }
    });
  }

  /** A file folds once viewed, and opens again once it is not, as the desktop view does. */
  private applyViewed(file: FileView): void {
    const state = file.progress?.state;

    if (!state || state === file.viewedApplied || file.state) return;
    const previous = file.viewedApplied;
    file.viewedApplied = state;

    const collapsed =
      state === "viewed"
        ? true
        : previous === "viewed" ||
            this.progress?.changedPaths?.includes(file.entry.file.path)
          ? false
          : undefined;

    if (collapsed === undefined || collapsed === file.collapsed) return;
    file.collapsed = collapsed;
    file.collapseSet = true;
    this.renderBody(file);
  }

  private renderHeader(file: FileView): void {
    const { entry } = file;
    const binary = !!entry.file.binary || isBinaryCounts(file.counts);
    const locked = binary || !!file.state;
    file.header.setAttribute(
      "aria-expanded",
      String(!file.collapsed && !locked),
    );
    file.header.classList.toggle("is-collapsed", file.collapsed || locked);
    file.header.setAttribute(
      "aria-label",
      `${file.collapsed ? "Expand" : "Collapse"} ${entry.file.path}`,
    );
    file.note.textContent =
      binary && isBinaryCounts(file.counts)
        ? `Binary file${binarySizeLabel(file.counts) ? ` · ${binarySizeLabel(file.counts)}` : ""}`
        : (file.hidden ?? (entry.file.status === "deleted" ? "Deleted" : ""));
    file.note.hidden = !file.note.textContent;
    const remaining = file.progress?.remaining;

    const counts =
      file.counts && !isBinaryCounts(file.counts) ? file.counts : undefined;

    const added = remaining?.additions ?? counts?.added;
    const removed = remaining?.deletions ?? counts?.removed;
    file.countsNode.replaceChildren();

    if (added) file.countsNode.append(element("span", "dv-added", `+${added}`));

    if (removed)
      file.countsNode.append(element("span", "dv-removed", `−${removed}`));
    file.viewed.update(file.progress?.state, entry.file.path, !file.progress);
    file.viewed.element.hidden = entry.file.status === "unchanged";
  }

  /** Draw a file's body if it is near the screen, else hold its place. */
  private renderBody(file: FileView): void {
    const diff = this.session.getTextDiff(file.entry.file.path);
    file.body.classList.remove("is-message");
    this.dropChunks(file);

    if (file.state || !diff || file.collapsed) {
      file.built = false;
      file.body.style.height = "";
      file.body.replaceChildren();

      const message =
        file.state ??
        (file.collapsed
          ? undefined
          : this.session.getFileResult(file.entry.file.path)?.error);

      if (message) {
        file.body.classList.add("is-message");
        file.body.textContent = message;
      }

      return;
    }

    if (!file.near) {
      // Off screen, a file keeps the height it was last drawn at, or a few rows' worth: diffr
      // folds most of a file away.
      file.body.style.height ||= `${PLACEHOLDER_ROWS * 22}px`;
      file.built = false;
      file.body.replaceChildren();

      return;
    }

    file.built = true;
    file.body.style.height = "";

    if (this.hover?.path === file.entry.file.path) this.clearScope();
    file.body.replaceChildren(
      this.renderDiff(file.entry.file.path, diff, file),
    );
    this.fillNear(file);
  }

  private onBuild(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const file = this.bySection.get(entry.target);

      if (!file || file.near) continue;
      file.near = true;
      this.renderBody(file);
    }
  }

  private onRelease(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (entry.isIntersecting) continue;
      const file = this.bySection.get(entry.target);

      if (!file?.near) continue;
      file.near = false;

      if (!file.built) continue;
      file.body.style.height = `${file.body.offsetHeight}px`;
      file.built = false;
      this.dropChunks(file);
      file.body.replaceChildren();
    }
  }

  /** A file's blocks, ready to draw when they near the screen. */
  private renderDiff(
    path: string,
    diff: StructuralTextDiff,
    file: FileView,
  ): HTMLElement {
    const collapsed = (id: number) => this.session.isRegionCollapsed(path, id);

    const context: RowContext = {
      text: {
        lhs: sourceLines(diff.lhs?.text),
        rhs: sourceLines(diff.rhs?.text),
      },
      syntax: { lhs: syntaxByLine(diff.lhs), rhs: syntaxByLine(diff.rhs) },
      changed: changedByLine(diff),
      path,
      ...this.viewedLines(path, diff, file),
    };

    const rows = element("div", this.split ? "dv-rows is-split" : "dv-rows");
    rows.style.setProperty(
      "--dv-digits",
      String(
        String(Math.max(context.text.lhs.length, context.text.rhs.length))
          .length,
      ),
    );

    if (this.split) {
      const items = splitItems(diff, collapsed);
      let inChange = false;

      const starts = items.map((item) => {
        if (item.kind === "band") {
          inChange = false;

          return item.change !== "unchanged";
        }

        const changed =
          item.left?.change === "removed" || item.right?.change === "added";

        const starts = changed && !inChange;
        inChange = changed;

        return starts;
      });

      this.planChunks(
        rows,
        file,
        items,
        starts,
        (item) =>
          item.kind === "band"
            ? {}
            : { lhs: item.left?.line, rhs: item.right?.line },
        (into, slice, sliceStarts) =>
          this.fillSplit(into, slice, sliceStarts, context),
      );
    } else {
      const items = unifiedItems(diff, collapsed);

      const starts = items.map((item, index) => {
        const previous = items[index - 1];

        return item.kind === "line"
          ? item.change !== "context" &&
              (previous?.kind !== "line" || previous.change === "context")
          : item.change !== "unchanged";
      });

      this.planChunks(
        rows,
        file,
        items,
        starts,
        (item) =>
          item.kind === "band" ? {} : { lhs: item.base, rhs: item.head },
        (into, slice, sliceStarts) =>
          slice.forEach((item, index) =>
            into.append(
              item.kind === "band"
                ? this.renderBand(item, sliceStarts[index]!)
                : this.renderLine(item, context, sliceStarts[index]!),
            ),
          ),
      );
    }

    if (!file.chunks.length)
      rows.append(element("div", "dv-empty", "No changes to show"));

    return rows;
  }

  /**
   * Cut `items` into blocks of rows, each held at its estimated height until it nears the screen,
   * then drawn, and emptied again, at its measured height, once far from it. A file of thousands
   * of rows draws only the ones around the reader.
   */
  private planChunks<T extends UnifiedItem | SplitItem>(
    rows: HTMLElement,
    file: FileView,
    items: readonly T[],
    starts: readonly boolean[],
    linesOf: (item: T) => { lhs?: number; rhs?: number },
    draw: (
      into: HTMLElement,
      slice: readonly T[],
      starts: readonly boolean[],
    ) => void,
  ): void {
    const line = this.compact ? 22 : 18;
    const band = this.compact ? 44 : 28;
    const pseudocode = this.compact ? 22 : 18;

    for (let first = 0; first < items.length; first += CHUNK) {
      const slice = items.slice(first, first + CHUNK);
      const sliceStarts = starts.slice(first, first + CHUNK);
      const lines: Chunk["lines"] = { lhs: undefined, rhs: undefined };
      let height = 0;

      for (const item of slice) {
        height +=
          item.kind === "band"
            ? band +
              (item.detail.length ? item.detail.length * pseudocode + 24 : 0)
            : line;
        const at = linesOf(item);

        for (const side of ["lhs", "rhs"] as const) {
          const value = at[side];

          if (value === undefined) continue;
          const range = lines[side];
          lines[side] = range
            ? [Math.min(range[0], value), Math.max(range[1], value)]
            : [value, value];
        }
      }

      const node = rows.appendChild(element("div", "dv-chunk"));
      node.style.height = `${height}px`;
      node.style.containIntrinsicBlockSize = `auto ${height}px`;

      const chunk: Chunk = {
        element: node,
        file,
        lines,
        changes: sliceStarts.some(Boolean),
        built: false,
        draw: (into) => draw(into, slice, sliceStarts),
      };

      file.chunks.push(chunk);
      this.chunkOf.set(node, chunk);
      this.chunkBuild.observe(node);
      this.chunkRelease.observe(node);
    }
  }

  private fillChunk(chunk: Chunk): void {
    if (chunk.built) return;
    chunk.built = true;
    chunk.element.style.height = "";
    chunk.draw(chunk.element);

    for (const pane of chunk.element.querySelectorAll<HTMLElement>(".dv-pane"))
      pane.scrollLeft =
        chunk.file.scrolled[pane.dataset.side === "rhs" ? "rhs" : "lhs"];
    this.applyFind();
  }

  private emptyChunk(chunk: Chunk): void {
    if (!chunk.built) return;
    chunk.element.style.height = `${chunk.element.offsetHeight}px`;
    chunk.built = false;
    chunk.element.replaceChildren();
  }

  /** Draw a file's blocks that are on or near the screen now, so it never shows empty. */
  private fillNear(file: FileView): void {
    const view = this.root.getBoundingClientRect();
    const margin = this.root.clientHeight * 1.5;

    for (const chunk of file.chunks) {
      const bounds = chunk.element.getBoundingClientRect();

      if (
        bounds.bottom > view.top - margin &&
        bounds.top < view.bottom + margin
      )
        this.fillChunk(chunk);
    }
  }

  /** Draw the block that holds one side's 0-based `line`. */
  private fillLine(file: FileView, side: "lhs" | "rhs", line: number): void {
    const chunk = file.chunks.find((chunk) => {
      const range = chunk.lines[side];

      return range && range[0] <= line && line <= range[1];
    });

    if (chunk && !chunk.built) this.preserve(() => this.fillChunk(chunk));
  }

  private dropChunks(file: FileView): void {
    for (const chunk of file.chunks) {
      this.chunkBuild.unobserve(chunk.element);
      this.chunkRelease.unobserve(chunk.element);
    }

    file.chunks = [];
  }

  /**
   * Split rows, in segments between bands. Unwrapped, a segment is two panes that scroll sideways
   * apart, kept level with the file's other segments; wrapped, it is one grid, so the two sides of
   * a row wrap to the same height.
   */
  private fillSplit(
    into: HTMLElement,
    items: readonly SplitItem[],
    starts: readonly boolean[],
    context: RowContext,
  ): void {
    let segment: ((left: HTMLElement, right: HTMLElement) => void) | undefined;

    const open = () => {
      if (this.wrapped) {
        const grid = into.appendChild(element("div", "dv-seg is-grid"));

        return (left: HTMLElement, right: HTMLElement) =>
          grid.append(left, right);
      }

      const seg = into.appendChild(element("div", "dv-seg"));

      const side = (name: "lhs" | "rhs") => {
        const pane = seg.appendChild(element("div", `dv-pane is-${name}`));
        pane.dataset.side = name;

        return pane.appendChild(element("div", "dv-pane-rows"));
      };

      const [left, right] = [side("lhs"), side("rhs")];

      return (cellLeft: HTMLElement, cellRight: HTMLElement) => {
        left.append(cellLeft);
        right.append(cellRight);
      };
    };

    const cell = (
      cell: SplitCell | undefined,
      side: "lhs" | "rhs",
      starts: boolean,
    ) => {
      if (!cell) {
        const filler = element("div", "dv-filler");
        filler.dataset.side = side;
        filler.classList.toggle("is-change-start", starts);

        return filler;
      }

      return this.renderLine(
        {
          kind: "line",
          change: cell.change,
          tinted: cell.tinted,
          base: side === "lhs" ? cell.line : undefined,
          head: side === "rhs" ? cell.line : undefined,
          side,
          fold: cell.fold,
          pill: cell.pill,
        },
        context,
        starts,
        side,
      );
    };

    items.forEach((item, index) => {
      if (item.kind === "band") {
        segment = undefined;
        into.append(this.renderBand(item, starts[index]!));

        return;
      }

      segment ??= open();
      segment(
        cell(item.left, "lhs", starts[index]!),
        cell(item.right, "rhs", false),
      );
    });
  }

  /** One line; `side`, in the split view, the side it is drawn on. */
  private renderLine(
    line: UnifiedLine,
    context: RowContext,
    startsChange: boolean,
    side?: "lhs" | "rhs",
  ): HTMLElement {
    const { text, syntax, changed } = context;
    const row = element("div", `dv-row is-${line.change}`);

    if (side) row.dataset.side = side;

    if (line.tinted) row.classList.add("is-tinted");

    if (startsChange) row.classList.add("is-change-start");

    if (line.base !== undefined) row.dataset.base = String(line.base);

    if (line.head !== undefined) row.dataset.head = String(line.head);
    const number = line.side === "lhs" ? line.base! : line.head!;
    const gutter = row.appendChild(element("span", "dv-gutter"));

    const fold =
      line.fold ??
      (line.pill && { foldStateId: line.pill.foldStateId, collapsed: true });

    if (fold) {
      row.classList.add("has-fold");
      row.classList.toggle("is-folded", fold.collapsed);
      row.dataset.fold = String(fold.foldStateId);
      row.dataset.collapsed = String(fold.collapsed);
      const button = gutter.appendChild(element("button", "dv-chevron"));
      button.type = "button";
      button.setAttribute("aria-expanded", String(!fold.collapsed));
      button.setAttribute(
        "aria-label",
        `${fold.collapsed ? "Expand" : "Fold"} scope at line ${number + 1}`,
      );
    }

    // Unified, a desktop has room for both sides' numbers, so a removed line's base number never
    // sits among the head's.
    if (!side && !this.compact)
      gutter.append(
        element(
          "span",
          "dv-lineno",
          line.base === undefined ? "" : String(line.base + 1),
        ),
        element(
          "span",
          "dv-lineno",
          line.head === undefined ? "" : String(line.head + 1),
        ),
      );
    else gutter.append(element("span", "dv-lineno", String(number + 1)));
    const code = row.appendChild(element("span", "dv-code"));
    const source = text[line.side][number] ?? "";

    // Wrapped, a long line continues under its own indentation, as an editor wraps it.
    if (this.wrapped) {
      let columns = 0;

      for (const character of source) {
        if (character === " ") columns++;
        else if (character === "\t") columns += 8 - (columns % 8);
        else break;
      }

      if (columns) code.style.setProperty("--dv-hang", `${columns}ch`);
    }

    code.append(
      renderCode(
        source,
        syntax[line.side].get(number),
        line.tinted ? changed[line.side].get(number) : undefined,
      ),
    );

    if (context.viewed[line.side].has(number)) row.classList.add("is-viewed");

    if (line.pill) {
      const viewed =
        context.viewed[line.side].size > 0 &&
        this.scopes.get(context.path, line.pill.foldStateId).state === "viewed";

      const pill = code.appendChild(
        element(
          "span",
          viewed ? "dv-pill is-viewed" : "dv-pill",
          `${viewed ? "✓" : "⋯"} ${line.pill.label}`,
        ),
      );

      pill.setAttribute("aria-hidden", "true");

      if (line.pill.closer)
        code.append(element("span", "dv-closer", ` ${line.pill.closer}`));
    }

    if (line.fold && context.viewedHeads[line.side].has(number)) {
      const control = this.scopeControl(
        context.path,
        line.fold.foldStateId,
        source.trim(),
      );

      if (control) row.append(control);
    }

    return row;
  }

  private renderBand(band: UnifiedBand, startsChange: boolean): HTMLElement {
    const node = element("div", `dv-band kind-${band.change}`);

    if (startsChange) node.classList.add("is-change-start");
    node.setAttribute("role", "button");
    node.tabIndex = 0;
    node.dataset.fold = String(band.foldStateId);
    node.style.setProperty("--dv-indent", String(band.indent));
    const summary = band.detail.length > 0;
    node.setAttribute(
      "aria-label",
      `Expand ${band.hidden} hidden line${band.hidden === 1 ? "" : "s"}${summary ? ", summarized" : `: ${band.title}`}`,
    );
    const title = node.appendChild(element("span", "dv-band-title"));
    title.append(element("span", "dv-band-chevron"));

    if (summary) title.append(element("span", "dv-band-caption", "Pseudocode"));
    title.append(element("span", "dv-band-label", band.title));

    if (summary) {
      const detail = node.appendChild(element("div", "dv-pseudocode"));

      for (const text of band.detail) {
        const line = detail.appendChild(
          element("div", "dv-pseudocode-line", text.trimStart() || " "),
        );

        line.style.setProperty(
          "--dv-indent",
          String(text.length - text.trimStart().length),
        );
      }
    }

    return node;
  }

  private onClick(event: Event): void {
    const target = event.target;

    if (!(target instanceof Element)) return;
    const overSelection = this.pressedOverSelection;
    this.pressedOverSelection = false;

    const scopeCheck = target.closest<HTMLElement>(".dv-scope > button");
    const rail = target.closest<HTMLElement>(".dv-rail");

    const scopePath = (scopeCheck ?? rail)?.closest<HTMLElement>(".dv-file")
      ?.dataset.path;

    if (scopeCheck && scopePath) {
      void this.scopes.toggle(scopePath, Number(scopeCheck.dataset.scope));

      return;
    }

    if (rail && scopePath) {
      this.session.setRegionCollapsed(
        scopePath,
        Number(rail.dataset.fold),
        true,
      );

      return;
    }

    if (target.closest(".review-viewed-check, .dv-open")) return;
    const section = target.closest<HTMLElement>(".dv-file");
    const file = section && this.files.get(section.dataset.path!);

    if (!file) return;
    const path = file.entry.file.path;

    if (target.closest(".dv-header")) {
      if (file.state || file.entry.file.binary || isBinaryCounts(file.counts))
        return;
      this.setFileCollapsed(path, !file.collapsed);

      return;
    }

    // Ending a selection, or making one, is not a request to fold.
    if (overSelection || !(window.getSelection()?.isCollapsed ?? true)) return;

    const band = target.closest<HTMLElement>(".dv-band");

    if (band) {
      this.session.setRegionCollapsed(path, Number(band.dataset.fold), false);

      return;
    }

    const line = target.closest<HTMLElement>(".dv-row");

    if (line) this.focusRow(line, false);

    // A phone folds from anywhere on the row; a desktop from its gutter, leaving the code to
    // select and click.
    const row = target
      .closest<HTMLElement>(
        this.compact ? ".dv-row.has-fold" : ".dv-row.has-fold .dv-gutter",
      )
      ?.closest<HTMLElement>(".dv-row");

    if (row)
      this.session.setRegionCollapsed(
        path,
        Number(row.dataset.fold),
        row.dataset.collapsed !== "true",
      );
  }

  /**
   * Keep the row at the top of the screen where it is while `change` redraws what is above or
   * around it. Browsers anchor scrolling on their own only when they redraw in place.
   */
  private preserve(change: () => void): void {
    const top = this.root.getBoundingClientRect().top;
    const anchor = this.anchor(top);
    change();

    if (!anchor) return;
    const node = anchor.find();

    if (!node) return;
    const delta = node.getBoundingClientRect().top - top - anchor.offset;

    if (Math.abs(delta) >= 1) this.root.scrollTop += delta;
  }

  private anchor(top: number) {
    const bounds = this.root.getBoundingClientRect();

    if (!bounds.height) return undefined;

    const hit = document
      .elementsFromPoint(bounds.left + bounds.width / 2, top + 1)
      .find(
        (node) =>
          this.root.contains(node) &&
          node.closest(".dv-row, .dv-band, .dv-file"),
      );

    const node = hit?.closest<HTMLElement>(".dv-row, .dv-band, .dv-file");

    const section = node?.closest<HTMLElement>(".dv-file");

    if (!node || !section) return undefined;
    const path = section.dataset.path!;

    const selector = node.classList.contains("dv-row")
      ? node.dataset.head !== undefined
        ? `.dv-row[data-head="${node.dataset.head}"]`
        : `.dv-row[data-base="${node.dataset.base}"]`
      : node.classList.contains("dv-band")
        ? `.dv-band[data-fold="${node.dataset.fold}"]`
        : undefined;

    const offset = node.getBoundingClientRect().top - top;

    return {
      offset,
      find: () => {
        const current = this.files.get(path)?.section;

        return (
          (selector && current?.querySelector<HTMLElement>(selector)) || current
        );
      },
    };
  }

  /** The topmost file on screen. */
  get activePath(): string | undefined {
    const top = this.root.scrollTop;
    const visible = this.order.filter((file) => !file.section.hidden);

    let low = 0,
      high = visible.length - 1,
      found: FileView | undefined;

    while (low <= high) {
      const middle = (low + high) >> 1;
      const file = visible[middle]!;

      if (file.section.offsetTop <= top + 1) {
        found = file;
        low = middle + 1;
      } else high = middle - 1;
    }

    return (found ?? visible[0])?.entry.file.path;
  }

  /** Scroll a file's header to the top; `open` also unfolds it. */
  revealFile(path: string, open = false): void {
    const file = this.files.get(path);

    if (!file) return;

    if (open) this.setFileCollapsed(path, false);
    this.settle(() => {
      this.root.scrollTop = file.section.offsetTop;

      return true;
    });
  }

  /** Scroll one side's 1-based `line` a third of the way down, once its folds have opened. */
  revealLine(path: string, side: "original" | "modified", line: number): void {
    const file = this.files.get(path);

    if (!file) return;
    this.setFileCollapsed(path, false);
    file.near = true;

    if (!file.built) this.renderBody(file);
    this.settle(() => {
      this.fillLine(file, side === "original" ? "lhs" : "rhs", line - 1);
      const row = this.rowFor(file, side, line - 1);

      if (!row) return false;

      const delta =
        row.getBoundingClientRect().top -
        this.root.getBoundingClientRect().top -
        this.root.clientHeight / 3;

      if (Math.abs(delta) > 1) this.root.scrollTop += delta;
      row.classList.remove("is-revealed");
      void row.offsetWidth;
      row.classList.add("is-revealed");

      return true;
    });
  }

  private rowFor(file: FileView, side: "original" | "modified", line: number) {
    return side === "original"
      ? (file.body.querySelector<HTMLElement>(
          `.dv-row.is-removed[data-base="${line}"]`,
        ) ??
          file.body.querySelector<HTMLElement>(`.dv-row[data-base="${line}"]`))
      : file.body.querySelector<HTMLElement>(`.dv-row[data-head="${line}"]`);
  }

  /**
   * Run `apply` over the next frames, as folds open and files above settle, until it reports it
   * found its target, the reader touches the list, or a second passes.
   */
  private settle(apply: () => boolean): void {
    this.reveal?.cancel();

    let frame = 0,
      frames = 0,
      done = false;

    const step = () => {
      const found = apply();
      done ||= found;

      if (++frames < (done ? 4 : 60)) frame = requestAnimationFrame(step);
    };

    const reveal = {
      cancel: () => {
        cancelAnimationFrame(frame);

        if (this.reveal === reveal) this.reveal = undefined;
      },
    };

    this.reveal = reveal;
    frame = requestAnimationFrame(step);
  }

  /** The next or previous run of changes, drawing the files it passes. */
  goToChange(direction: "next" | "previous"): void {
    // Changes land on the reading line, a third of the way down, so they are measured from it.
    const line =
      this.root.getBoundingClientRect().top + this.root.clientHeight / 3;

    const active = this.order.findIndex(
      (file) => file.entry.file.path === this.activePath,
    );

    const sequence = (
      direction === "next"
        ? this.order.slice(Math.max(0, active))
        : this.order.slice(0, active + 1).reverse()
    ).filter((file) => !file.section.hidden && !file.collapsed);

    for (const file of sequence) {
      if (!file.built && !file.state) {
        file.near = true;
        this.preserve(() => this.renderBody(file));
      }

      // Only blocks with a change past the reading line are drawn to look in them.
      const chunks = file.chunks.filter((chunk) => {
        if (!chunk.changes) return false;
        const bounds = chunk.element.getBoundingClientRect();

        return direction === "next"
          ? bounds.bottom - line > 8
          : bounds.top - line < -8;
      });

      if (direction === "previous") chunks.reverse();

      for (const chunk of chunks) {
        this.preserve(() => this.fillChunk(chunk));

        const starts = [
          ...chunk.element.querySelectorAll<HTMLElement>(".is-change-start"),
        ];

        const target =
          direction === "next"
            ? starts.find((node) => node.getBoundingClientRect().top - line > 8)
            : starts
                .reverse()
                .find((node) => node.getBoundingClientRect().top - line < -8);

        if (target) {
          this.root.scrollTop += target.getBoundingClientRect().top - line;

          return;
        }
      }
    }
  }

  scroll(to: number | "top" | "end"): void {
    this.reveal?.cancel();

    if (to === "top") this.root.scrollTop = 0;
    else if (to === "end") this.root.scrollTop = this.root.scrollHeight;
    else this.root.scrollTop += to;
  }

  focus(): void {
    this.root.focus({ preventScroll: true });
  }

  /** Mark find's matches in the files drawn, with the CSS Custom Highlight API where it exists. */
  showFindMatches(matches: FindMatch[], current: number): void {
    this.find = matches.length ? { matches, current } : undefined;
    this.applyFind();
  }

  private applyFind(): void {
    const highlights = CSS.highlights;

    if (!highlights) return;
    const all: Range[] = [];
    const current: Range[] = [];
    const find = this.find;

    if (find) {
      find.matches.forEach((match, index) => {
        const file = this.files.get(match.path);

        if (!file?.built) return;
        const row = this.rowFor(file, match.side, match.line - 1);
        const code = row?.querySelector(".dv-code");
        const range = code && textRange(code, match.column - 1, match.length);

        if (!range) return;
        (index === find.current ? current : all).push(range);
      });
    }

    highlights.set("diffr-find", new Highlight(...all));
    highlights.set("diffr-find-current", new Highlight(...current));
  }

  private showStatus(): void {
    const states = this.order.map((file) => file.state);
    const loading = states.filter((state) => state === LOADING).length;
    this.status.hidden = !loading;
    this.status.textContent = loading
      ? `Diffing ${this.order.length - loading} of ${this.order.length} files…`
      : "";
  }

  /** Show or hide the desktop's file tree; a phone's is a sheet (mobileFiles.ts). */
  toggleFileTree(): void {
    this.sidebarHidden = !this.sidebarHidden;
    this.applyScreen();
  }

  /**
   * The diffr TUI's `z` commands, at the row the reader last clicked or reached with `zj`/`zk`,
   * else the row on the reading line: `a` toggles the fold there, `o` opens and `c` closes it (in
   * capitals, with every fold inside it), and `j`/`k` go to the next or previous fold.
   */
  foldCommand(command: string): void {
    const row = this.currentRow();

    if (!row) return;

    if (command === "j" || command === "k") {
      const rows = [
        ...this.root.querySelectorAll<HTMLElement>(".dv-row.has-fold"),
      ];

      const at = rows.indexOf(row);

      const next =
        command === "j"
          ? rows.find(
              (candidate, index) =>
                index > at &&
                candidate.getBoundingClientRect().top >
                  row.getBoundingClientRect().top,
            )
          : rows.findLast(
              (candidate, index) =>
                index < at &&
                candidate.getBoundingClientRect().top <
                  row.getBoundingClientRect().top,
            );

      if (next) this.focusRow(next);

      return;
    }

    const letter = command.toLowerCase();
    const scope = this.scopeAt(row);
    const diff = scope && this.session.getTextDiff(scope.path);

    if (!scope || !diff || !"aoc".includes(letter)) return;
    const collapse = letter === "a" ? !scope.collapsed : letter === "c";
    const id = scope.foldable.foldStateId;

    for (const each of command !== letter ? [id, ...nestedIds(diff, id)] : [id])
      this.session.setRegionCollapsed(scope.path, each, collapse);
  }

  private readonly foldablesBySource = new WeakMap<
    StructuralSource,
    StructuralFoldable[]
  >();

  /** A side's foldables with chevrons, worked out once per diff. */
  private foldablesOf(source: StructuralSource | undefined) {
    if (!source) return [];
    let foldables = this.foldablesBySource.get(source);

    if (!foldables) {
      foldables = structuralFoldables(source).filter(
        (foldable) => foldable.chevron,
      );
      this.foldablesBySource.set(source, foldables);
    }

    return foldables;
  }

  /** The fold `row` heads, else the smallest open scope around it, on the row's side. */
  private scopeAt(row: HTMLElement): Scope | undefined {
    const path = row.closest<HTMLElement>(".dv-file")?.dataset.path;
    const diff = path ? this.session.getTextDiff(path) : undefined;

    if (!path || !diff) return undefined;

    const side =
      row.dataset.head !== undefined && row.dataset.side !== "lhs"
        ? "rhs"
        : "lhs";

    const line = Number(side === "rhs" ? row.dataset.head : row.dataset.base);
    const foldables = this.foldablesOf(side === "rhs" ? diff.rhs : diff.lhs);

    const collapsed = (foldable: StructuralFoldable) =>
      this.session.isRegionCollapsed(path, foldable.foldStateId) ??
      foldable.collapsedByDefault;

    const foldable =
      foldables.find((candidate) => candidate.line === line) ??
      foldables
        .filter(
          (candidate) =>
            candidate.rail &&
            !collapsed(candidate) &&
            candidate.rail.start <= line &&
            line <= candidate.rail.end,
        )
        .sort(
          (a, b) => a.rail!.end - a.rail!.start - (b.rail!.end - b.rail!.start),
        )[0];

    return foldable && { path, side, foldable, collapsed: collapsed(foldable) };
  }

  /**
   * The lines the reader has viewed, and the viewed scopes whose control stays on their header:
   * each outermost one, since it accounts for the scopes inside it.
   */
  private viewedLines(path: string, diff: StructuralTextDiff, file: FileView) {
    const ranges = this.scopes.getViewedRanges(path);
    file.viewedKey = JSON.stringify(ranges);
    const viewed = { lhs: new Set<number>(), rhs: new Set<number>() };
    const viewedHeads = { lhs: new Set<number>(), rhs: new Set<number>() };

    for (const range of ranges)
      for (let line = range.fromLine; line <= range.toLine; line++)
        viewed[range.side === "head" ? "rhs" : "lhs"].add(line - 1);

    if (this.compact || !ranges.length) return { viewed, viewedHeads };

    for (const side of ["lhs", "rhs"] as const) {
      const done = this.foldablesOf(diff[side]).filter(
        (foldable) =>
          foldable.rail &&
          viewed[side].has(foldable.line) &&
          this.scopes.get(path, foldable.foldStateId).state === "viewed",
      );

      for (const scope of done)
        if (
          !done.some(
            (outer) =>
              outer.line < scope.line && outer.rail!.end >= scope.rail!.end,
          )
        )
          viewedHeads[side].add(scope.line);
    }

    return { viewed, viewedHeads };
  }

  /** Redraw the files whose viewed lines changed. */
  private syncViewed(): void {
    this.preserve(() => {
      for (const file of this.order)
        if (
          file.built &&
          file.viewedKey !==
            JSON.stringify(this.scopes.getViewedRanges(file.entry.file.path))
        )
          this.renderBody(file);
    });
  }

  /** A scope's changes left to read and its viewed box; none for a scope with no changes. */
  private scopeControl(
    path: string,
    foldStateId: number,
    subject: string,
  ): HTMLElement | undefined {
    const progress = this.scopes.get(path, foldStateId);

    if (!progress.total.additions && !progress.total.deletions)
      return undefined;
    const control = element("span", "dv-scope");

    if (progress.remaining.additions)
      control.append(
        element("span", "dv-scope-added", `+${progress.remaining.additions}`),
      );

    if (progress.remaining.deletions)
      control.append(
        element("span", "dv-scope-removed", `−${progress.remaining.deletions}`),
      );
    const viewed = progress.state === "viewed";

    if (viewed) control.append(element("span", "dv-scope-status", "Viewed"));
    const check = control.appendChild(element("button", "review-viewed-check"));
    check.type = "button";
    check.dataset.scope = String(foldStateId);
    check.setAttribute("role", "checkbox");
    check.setAttribute(
      "aria-checked",
      progress.state === "partial" ? "mixed" : String(viewed),
    );
    check.setAttribute(
      "aria-label",
      `${viewed ? "Mark unviewed" : "Mark viewed"}: ${subject}`,
    );

    return control;
  }

  private hover:
    | { key: string; path: string; marks: HTMLElement[] }
    | undefined;
  private hoverRow: HTMLElement | undefined;

  /**
   * A desktop lights the scope under the pointer: its header, its viewed control and a rail down
   * its body that folds it. A phone folds by pinching: in over a scope to fold it, out over a fold
   * to open it.
   */
  private listenForScopes(): void {
    this.root.addEventListener(
      "pointermove",
      (event) => {
        if (this.compact || event.pointerType !== "mouse") return;
        const target = event.target instanceof Element ? event.target : null;

        // The pointer on a scope's rail or control is still in the scope.
        if (target?.closest(".dv-rail, .dv-scope")) return;
        const row = target?.closest<HTMLElement>(".dv-row") ?? undefined;

        if (row === this.hoverRow) return;
        this.hoverRow = row;
        const scope = row && this.scopeAt(row);

        const key =
          scope &&
          `${scope.path}\0${scope.side}\0${scope.foldable.foldStateId}`;

        if (key === this.hover?.key) return;
        this.clearScope();

        if (scope && key) this.showScope(scope, key);
      },
      { passive: true },
    );
    this.root.addEventListener("pointerleave", () => {
      this.hoverRow = undefined;
      this.clearScope();
    });

    let pinch:
      | { distance: number; x: number; y: number; done: boolean }
      | undefined;

    const spread = (touches: TouchList) =>
      Math.hypot(
        touches[0]!.clientX - touches[1]!.clientX,
        touches[0]!.clientY - touches[1]!.clientY,
      );

    // The page never zooms here (touch-action in diffView.css), so these never need to cancel
    // the browser's scrolling, and stay passive.
    this.root.addEventListener(
      "touchstart",
      (event) => {
        pinch =
          this.compact && event.touches.length === 2
            ? {
                distance: spread(event.touches),
                x: (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2,
                y: (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2,
                done: false,
              }
            : undefined;
      },
      { passive: true },
    );
    this.root.addEventListener(
      "touchmove",
      (event) => {
        if (!pinch || pinch.done || event.touches.length !== 2) return;
        const delta = spread(event.touches) - pinch.distance;

        if (Math.abs(delta) < Math.max(24, pinch.distance * 0.18)) return;
        pinch.done = true;
        this.pinchFold(pinch.x, pinch.y, delta < 0);
      },
      { passive: true },
    );

    for (const type of ["touchend", "touchcancel"])
      this.root.addEventListener(type, () => (pinch = undefined), {
        passive: true,
      });
  }

  private showScope(scope: Scope, key: string): void {
    const file = this.files.get(scope.path);

    if (!file?.built) return;
    const { side, foldable } = scope;
    const marks: HTMLElement[] = [];
    this.hover = { key, path: scope.path, marks };
    const cells = this.split ? `.dv-row[data-side="${side}"]` : ".dv-row";
    const attribute = side === "rhs" ? "head" : "base";

    const header =
      file.body.querySelector<HTMLElement>(
        `${cells}.has-fold[data-${attribute}="${foldable.line}"]`,
      ) ?? undefined;

    if (header) {
      header.classList.add("is-scope-head");
      marks.push(header);

      if (!header.querySelector(".dv-scope")) {
        const control = this.scopeControl(
          scope.path,
          foldable.foldStateId,
          header.querySelector(".dv-code")?.textContent?.trim() ?? "scope",
        );

        if (control) {
          header.append(control);
          marks.push(control);
        }
      }
    }

    if (scope.collapsed || !foldable.rail) return;

    // Its braces light up too, wherever they are drawn.
    const braces: Range[] = [];

    for (const brace of foldable.braces
      ? [foldable.braces.opener, foldable.braces.closer]
      : []) {
      const code = file.body.querySelector(
        `${cells}[data-${attribute}="${brace.line - 1}"] .dv-code`,
      );

      const range = code && textRange(code, brace.column - 1, 1);

      if (range) braces.push(range);
    }

    CSS.highlights?.set("diffr-scope-brace", new Highlight(...braces));

    // The body's rows on this side, by the block or pane that holds them: a rail is drawn in each.
    const groups = new Map<HTMLElement, HTMLElement[]>();

    for (const row of file.body.querySelectorAll<HTMLElement>(cells)) {
      const value = row.dataset[attribute];

      if (value === undefined) continue;
      const line = Number(value);

      if (line <= foldable.line || line >= foldable.rail.end) continue;
      const parent = row.parentElement!;
      const rows = groups.get(parent) ?? [];
      rows.push(row);
      groups.set(parent, rows);
    }

    const first = groups.values().next().value?.[0];
    const code = first?.querySelector<HTMLElement>(".dv-code");

    if (!code) return;
    // The rail runs down the header's indentation, measured in the code's own font.
    const source = this.session.getTextDiff(scope.path)?.[side]?.text ?? "";
    const headerText = sourceLines(source)[foldable.line] ?? "";

    const measure = code.appendChild(
      element("span", undefined, /^[\t ]*/.exec(headerText)![0]),
    );

    const indent = measure.getBoundingClientRect().width;
    measure.remove();
    const padding = parseFloat(getComputedStyle(code).paddingLeft) || 0;
    const lines = foldable.rail.end - foldable.rail.start;

    for (const [parent, rows] of groups) {
      const bounds = parent.getBoundingClientRect();
      const top = rows[0]!.getBoundingClientRect().top;
      const bottom = rows.at(-1)!.getBoundingClientRect().bottom;

      const left = rows[0]!
        .querySelector(".dv-code")!
        .getBoundingClientRect().left;

      const rail = parent.appendChild(element("div", "dv-rail"));
      rail.dataset.fold = String(foldable.foldStateId);
      rail.title = `Fold ${lines} line${lines === 1 ? "" : "s"}`;
      rail.style.top = `${top - bounds.top}px`;
      rail.style.height = `${bottom - top}px`;
      rail.style.left = `${left - bounds.left + padding + indent}px`;
      marks.push(rail);
    }
  }

  private clearScope(): void {
    CSS.highlights?.delete("diffr-scope-brace");

    for (const mark of this.hover?.marks ?? [])
      if (mark.classList.contains("dv-row"))
        mark.classList.remove("is-scope-head");
      else mark.remove();

    this.hover = undefined;
  }

  /** Fold the open scope under a pinch, or open the fold nearest one. */
  private pinchFold(x: number, y: number, collapse: boolean): void {
    const hit = document
      .elementsFromPoint(x, y)
      .find((node) => this.root.contains(node));

    const row = hit?.closest<HTMLElement>(".dv-row");
    const scope = collapse && row ? this.scopeAt(row) : undefined;

    if (scope && !scope.collapsed) {
      this.session.setRegionCollapsed(
        scope.path,
        scope.foldable.foldStateId,
        true,
      );

      return;
    }

    const folds = collapse
      ? ".dv-row.has-fold:not(.is-folded)"
      : ".dv-band, .dv-row.is-folded";

    // Fingers are wide: the fold under the pinch, else the nearest within a tap target's reach.
    let nearest = hit?.closest<HTMLElement>(folds) ?? undefined;
    let best = 44;

    if (!nearest)
      for (const node of this.root.querySelectorAll<HTMLElement>(folds)) {
        const bounds = node.getBoundingClientRect();
        const distance = Math.abs((bounds.top + bounds.bottom) / 2 - y);

        if (distance > best) continue;
        best = distance;
        nearest = node;
      }

    const path = nearest?.closest<HTMLElement>(".dv-file")?.dataset.path;

    if (nearest && path)
      this.session.setRegionCollapsed(
        path,
        Number(nearest.dataset.fold),
        collapse,
      );
  }

  private caret: { path: string; selector: string } | undefined;

  /** The row fold commands act on. */
  private currentRow(): HTMLElement | undefined {
    if (this.caret) {
      const row = this.files
        .get(this.caret.path)
        ?.body.querySelector<HTMLElement>(this.caret.selector);

      const bounds = row?.getBoundingClientRect();
      const view = this.root.getBoundingClientRect();

      if (row && bounds && bounds.bottom > view.top && bounds.top < view.bottom)
        return row;
    }

    const view = this.root.getBoundingClientRect();

    return (
      document
        .elementsFromPoint(
          view.left + view.width / 2,
          view.top + view.height / 3,
        )
        .find((node) => this.root.contains(node) && node.closest(".dv-row"))
        ?.closest<HTMLElement>(".dv-row") ?? undefined
    );
  }

  /** Remember `row` for the next fold command, and bring it to the reading line. */
  private focusRow(row: HTMLElement, scroll = true): void {
    const path = row.closest<HTMLElement>(".dv-file")?.dataset.path;

    if (!path) return;
    const side = row.dataset.side;

    const selector =
      row.dataset.head !== undefined
        ? `.dv-row[data-head="${row.dataset.head}"]${side ? `[data-side="${side}"]` : ""}`
        : `.dv-row[data-base="${row.dataset.base}"]${side ? `[data-side="${side}"]` : ""}`;

    this.caret = { path, selector };

    for (const old of this.root.querySelectorAll(".dv-row.is-caret"))
      old.classList.remove("is-caret");

    // A click already shows where it is; a key that moves the place marks it.
    if (!scroll) return;
    row.classList.add("is-caret");
    const bounds = row.getBoundingClientRect();
    const view = this.root.getBoundingClientRect();

    if (bounds.top < view.top + 40 || bounds.bottom > view.bottom - 40)
      this.root.scrollTop += bounds.top - view.top - this.root.clientHeight / 3;
  }

  // Review Desktop's surface for find in its editors: these rows are no editor.
  codeEditor(): undefined {
    return undefined;
  }
}

const syntaxCache = new WeakMap<
  StructuralSource,
  Map<number, StructuralSyntaxSpan[]>
>();

function syntaxByLine(source: StructuralSource | undefined) {
  if (!source) return new Map<number, StructuralSyntaxSpan[]>();
  let byLine = syntaxCache.get(source);

  if (!byLine) {
    byLine = new Map();

    for (const span of source.syntax ?? []) {
      const group = byLine.get(span.line);

      if (group) group.push(span);
      else byLine.set(span.line, [span]);
    }

    syntaxCache.set(source, byLine);
  }

  return byLine;
}

const changedCache = new WeakMap<
  StructuralTextDiff,
  Record<"lhs" | "rhs", Map<number, [number, number][]>>
>();

/** Each side's changed token spans by zero-based line, as zero-based UTF-16 ranges. */
function changedByLine(diff: StructuralTextDiff) {
  let result = changedCache.get(diff);

  if (!result) {
    const highlights = structuralHighlights(diff);

    const group = (
      spans: readonly {
        startLineNumber: number;
        startColumn: number;
        endColumn: number;
      }[],
    ) => {
      const byLine = new Map<number, [number, number][]>();

      for (const span of spans) {
        const line = span.startLineNumber - 1;
        const ranges = byLine.get(line) ?? [];
        ranges.push([span.startColumn - 1, span.endColumn - 1]);
        byLine.set(line, ranges);
      }

      return byLine;
    };

    result = {
      lhs: group(highlights.original),
      rhs: group(highlights.modified),
    };
    changedCache.set(diff, result);
  }

  return result;
}

/** A line's text, split where its syntax role or changed tint begins or ends. */
function renderCode(
  text: string,
  syntax: readonly StructuralSyntaxSpan[] | undefined,
  changed: readonly [number, number][] | undefined,
): DocumentFragment | Text {
  const shown = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;

  if (!syntax?.length && !changed?.length)
    return document.createTextNode(shown);
  const roles: [number, number, SyntaxRole][] = [];

  for (const span of syntax ?? []) {
    const role = syntaxRole(span.capture);

    if (role)
      roles.push([
        utf16Column(text, span.start_column) - 1,
        utf16Column(text, span.end_column) - 1,
        role,
      ]);
  }

  const cuts = new Set([0, shown.length]);

  for (const [start, end] of [...roles, ...(changed ?? [])]) {
    cuts.add(Math.min(start, shown.length));
    cuts.add(Math.min(end, shown.length));
  }

  const points = [...cuts].sort((a, b) => a - b);
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]!,
      end = points[index + 1]!;

    if (start === end) continue;
    const role = roles.find(([from, to]) => from <= start && end <= to)?.[2];
    const tinted = changed?.some(([from, to]) => from <= start && end <= to);
    const piece = shown.slice(start, end);

    if (!role && !tinted) {
      fragment.append(piece);
      continue;
    }

    const span = element("span", undefined, piece);

    if (role) span.className = `dv-${role}`;

    if (tinted) span.classList.add("dv-changed");
    fragment.append(span);
  }

  return fragment;
}

/** The DOM range over `length` UTF-16 units of `node`'s text, from `offset`. */
function textRange(
  node: Node,
  offset: number,
  length: number,
): Range | undefined {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  let seen = 0,
    started = false;

  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const size = text.textContent?.length ?? 0;

    if (!started && offset < seen + size) {
      range.setStart(text, offset - seen);
      started = true;
    }

    if (started && offset + length <= seen + size) {
      range.setEnd(text, offset + length - seen);

      return range;
    }

    seen += size;
  }

  return undefined;
}
