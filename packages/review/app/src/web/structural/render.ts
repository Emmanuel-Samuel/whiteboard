// Adapted from diffr (MIT) web/src/view/file.ts at 62575763d.
import { SVGSpriteSheet, wrapCoreCSS } from "@pierre/diffs";

import type { Diffed } from "./diffed";
import type { StructuralStatus } from "./engine";
import { lineAt, lineCount } from "./lines";
import { defaultCollapsed } from "./regions";
import { type Cell, type Layout, type Row, buildRows, prepare } from "./rows";
import { escape, lineHtml, tokenCss } from "./tokens";

export type { Layout };

export interface StructuralFile {
  path: string;
  previousPath?: string;
  status: StructuralStatus;
}

export interface StructuralView {
  readonly element: HTMLElement;
  render(layout: Layout, theme: "dark" | "light"): void;
}

const extraCss = `
:host {
  display: block;
  --diffs-dark: #d4d4d4; --diffs-dark-bg: #171717;
  --diffs-dark-addition-color: #60d199; --diffs-dark-deletion-color: #ff6762; --diffs-dark-modified-color: #69b1ff;
  --diffs-light: #404040; --diffs-light-bg: #ffffff;
  --diffs-light-addition-color: #07c480; --diffs-light-deletion-color: #ff2e3f; --diffs-light-modified-color: #009fff;
}
:host([data-theme="dark"]) { color-scheme: dark; }
:host([data-theme="light"]) { color-scheme: light; }
[data-title] { color: var(--diffs-fg); }
[data-prev-name] { color: var(--diffs-fg-number); }
[data-rename-arrow] { color: var(--diffs-fg-number); flex: none; }
[data-separator-content][data-fold], [data-expand-button][data-fold] { cursor: pointer; }
[data-separator-content][data-fold]:hover { color: var(--diffs-fg); }
[data-separator][data-tint="inserted"] [data-separator-content],
[data-separator][data-tint="inserted"] [data-expand-button] { color: var(--diffs-addition-base); }
[data-separator][data-tint="removed"] [data-separator-content],
[data-separator][data-tint="removed"] [data-expand-button] { color: var(--diffs-deletion-base); }
[data-unmodified-lines] [data-count] { opacity: .6; margin-left: 1ch; }
[data-expand-button] { justify-content: center; color: var(--diffs-fg-number); }
[data-expand-button]:hover { color: var(--diffs-fg); }
[data-expand-button] svg { width: 16px; height: 16px; fill: currentColor; }
[data-fold-label] { color: var(--diffs-fg-number); font-style: italic; }
[data-fold-toggle] {
  position: absolute; left: 2px; top: 0; height: 20px; width: 14px; padding: 0; border: 0; background: none;
  display: grid; place-items: center; color: var(--diffs-fg-number); opacity: 0; cursor: pointer;
}
[data-fold-toggle] svg { width: 10px; height: 10px; fill: currentColor; }
[data-column-number]:hover [data-fold-toggle], [data-fold-toggle]:focus-visible { opacity: 1; }
[data-fold-toggle]:hover { color: var(--diffs-fg); }
[data-message] {
  display: flex; align-items: center; gap: 8px; height: 44px; box-sizing: border-box; padding: 0 16px;
  color: var(--diffs-fg-number); background: var(--diffs-bg);
  font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
}
[data-message] button {
  font: inherit; color: var(--diffs-fg); background: var(--diffs-bg-separator); border: 0; border-radius: 6px;
  padding: 2px 10px; cursor: pointer;
}
${tokenCss}
`;

let sheet: CSSStyleSheet | undefined;

const styleSheet = () => {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(wrapCoreCSS(extraCss));
  }

  return sheet;
};

const spriteIds = [
  "chevron",
  "expand-all",
  "symbol-added",
  "symbol-deleted",
  "symbol-modified",
  "symbol-moved",
];

const sprite = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">${spriteIds
  .map(
    (id) =>
      SVGSpriteSheet.match(
        new RegExp(`<symbol id="diffs-icon-${id}"[\\s\\S]*?</symbol>`),
      )?.[0] ?? "",
  )
  .join("")}</svg>`;

const icon = (id: string, attrs = "") =>
  `<svg ${attrs} viewBox="0 0 16 16" width="16" height="16"><use href="#diffs-icon-${id}"></use></svg>`;

const changeTypes = new Map<StructuralStatus, string>([
  ["added", "new"],
  ["deleted", "deleted"],
  ["modified", "change"],
  ["renamed", "rename-changed"],
  ["copied", "rename-changed"],
  ["type_changed", "change"],
]);

const changeIcons = new Map([
  ["new", "symbol-added"],
  ["deleted", "symbol-deleted"],
  ["change", "symbol-modified"],
  ["rename-changed", "symbol-moved"],
]);

export function createStructuralView(
  diffed: Diffed,
  file: StructuralFile,
): StructuralView {
  const { event } = diffed;

  if (event.diff?.type !== "text")
    throw new Error("Only text diffs render structurally.");
  const diff = event.diff;
  const prepared = prepare(diff, diffed.lines, diffed.syntax);
  const collapsed = defaultCollapsed(diff);
  const element = document.createElement("diffr-file");
  const root = element.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [styleSheet()];
  let revealed = !event.visibility.collapsed;
  let current: [Layout, "dark" | "light"] = ["split", "dark"];

  const oneSided = file.status === "added" || file.status === "deleted";

  const headerHtml = () => {
    const type = changeTypes.get(file.status) ?? "change";

    const prev =
      file.previousPath && file.previousPath !== file.path
        ? `<div data-prev-name><bdi>${escape(file.previousPath)}</bdi></div><span data-rename-arrow>→</span>`
        : "";

    const { added, removed } = diff.stats.visible;

    return (
      `<div data-diffs-header="default" data-change-type="${type}">` +
      `<div data-header-content>${icon(changeIcons.get(type)!, `data-change-icon="${type}"`)}` +
      `${prev}<div data-title><bdi>${escape(file.path)}</bdi></div></div>` +
      `<div data-metadata>${removed ? `<span data-deletions-count>-${removed}</span>` : ""}` +
      `${added ? `<span data-additions-count>+${added}</span>` : ""}</div></div>`
    );
  };

  const separator = (
    row: Extract<Row, { type: "fold" }>,
    index: number,
    last: number,
    content: boolean,
  ) => {
    const edge = `${index === 0 ? " data-separator-first" : ""}${index === last ? " data-separator-last" : ""}`;

    const count = /^\d/.test(row.label)
      ? ""
      : `<span data-count>${row.lines.toLocaleString()} lines</span>`;

    return (
      `<div data-separator="line-info" data-expand-index="${index}" data-tint="${row.tint}"${edge}>` +
      (content
        ? ""
        : `<div data-separator-wrapper><div data-expand-button data-expand-both data-fold="${row.id}" title="Expand">${icon("expand-all")}</div>` +
          `<div data-separator-content data-fold="${row.id}"><span data-unmodified-lines>${escape(row.label)}${count}</span></div></div>`) +
      `</div>`
    );
  };

  const numberCell = (cell: Cell) => {
    const toggle =
      cell.fold && !cell.fold.collapsed
        ? `<button data-fold-toggle data-fold="${cell.fold.id}" title="Fold${cell.fold.label ? `: ${escape(cell.fold.label.split("\n")[0]!)}` : ""}">${icon("chevron")}</button>`
        : "";

    return `<div data-line-type="${cell.kind}" data-column-number="${cell.line + 1}">${toggle}<span data-line-number-content>${cell.line + 1}</span></div>`;
  };

  const lineCell = (cell: Cell) => {
    const text = lineAt(prepared.texts[cell.side], cell.line);

    const alt =
      cell.alt === undefined ? "" : ` data-alt-line="${cell.alt + 1}"`;

    return (
      `<div data-line="${cell.line + 1}"${alt} data-line-type="${cell.kind}">` +
      `${lineHtml(text, prepared.syntax[cell.side], cell.line, cell.changed)}</div>`
    );
  };

  const code = (rows: Row[], side: 0 | 1 | undefined) => {
    let gutter = "";
    let content = "";
    let count = 0;
    let buffer = 0;
    const last = rows.length - 1;

    const flush = () => {
      if (!buffer) return;
      const style = `grid-row: span ${buffer};min-height:calc(${buffer} * 1lh);`;
      gutter += `<div data-gutter-buffer="buffer" data-buffer-size="${buffer}" style="${style}"></div>`;
      content += `<div data-content-buffer data-buffer-size="${buffer}" style="${style}"></div>`;
      count += buffer;
      buffer = 0;
    };

    rows.forEach((row, index) => {
      if (row.type === "fold") {
        flush();
        gutter += separator(row, index, last, false);
        content += separator(row, index, last, true);
        count++;

        for (const text of row.extra) {
          gutter += `<div data-line-type="context" data-column-number=""></div>`;
          content += `<div data-line data-line-type="context" data-fold-label>${escape(text)}</div>`;
          count++;
        }

        return;
      }

      const cell = "cell" in row ? row.cell : side ? row.right : row.left;

      if (!cell) {
        buffer++;

        return;
      }

      flush();
      gutter += numberCell(cell);
      content += lineCell(cell);
      count++;
    });
    flush();

    const attr =
      side === undefined
        ? "data-unified"
        : side
          ? "data-additions"
          : "data-deletions";

    return (
      `<code data-code ${attr} data-container-size><div data-gutter style="grid-row: span ${count}">${gutter}</div>` +
      `<div data-content style="grid-row: span ${count}">${content}</div></code>`
    );
  };

  const bodyHtml = (layout: Layout) => {
    if (!revealed)
      return `<div data-message><button data-reveal>Load diff</button>${escape(event.visibility.label || "Hidden by default")}</div>`;
    const rows = buildRows(prepared, layout, collapsed);

    if (!rows.length)
      return `<div data-message>${!prepared.texts[0].text && !prepared.texts[1].text ? "Empty file" : "No changes to show"}</div>`;

    const digits = Math.max(
      3,
      String(
        Math.max(lineCount(prepared.texts[0]), lineCount(prepared.texts[1])),
      ).length,
    );

    const split = layout === "split";

    return (
      `<pre data-diff data-indicators="bars" data-background data-diff-type="${split ? "split" : "single"}" data-overflow="scroll" style="--diffs-min-number-column-width-default:${digits}ch">` +
      (split ? code(rows, 0) + code(rows, 1) : code(rows, undefined)) +
      `</pre>`
    );
  };

  const render = (layout: Layout, theme: "dark" | "light") => {
    current = [layout, theme];
    element.dataset.theme = theme;
    root.innerHTML =
      sprite + headerHtml() + bodyHtml(oneSided ? "unified" : layout);
  };

  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const fold = event.target.closest<HTMLElement>("[data-fold]");

    if (fold) {
      const id = Number(fold.dataset.fold);

      if (!collapsed.delete(id)) collapsed.add(id);
    } else if (event.target.closest("[data-reveal]")) revealed = true;
    else return;
    render(...current);
  });

  return { element, render };
}
