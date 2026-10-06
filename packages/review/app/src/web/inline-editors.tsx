import type {
  ReviewFindQuery,
  ReviewInlineEditorFactory,
  ReviewInlineEditorRange,
  ReviewInlineFindSpec,
} from "@dev.fast/review-protocol";
import type { ThemedToken } from "@pierre/diffs";
import type { SharedReview } from "@review/sharing/read";
import * as stylex from "@stylexjs/stylex";

import { highlight } from "./highlight";
import { peekStyles as styles } from "./web-styles";

type Review = Pick<SharedReview, "text" | "snapshot">;

type Token = Pick<ThemedToken, "content" | "color" | "fontStyle">;

interface Match {
  start: number;
  end: number;
  index: number;
}

interface Found {
  byLine: Map<number, Match[]>;
  count: number;
}

const ITALIC = 1;

const BOLD = 2;

function source(
  review: Review,
  spec: Pick<ReviewInlineFindSpec, "path" | "side" | "pins">,
) {
  const commit = spec.pins
    ? spec.side === "base"
      ? (spec.pins.base ?? spec.pins.head)
      : spec.pins.head
    : review.snapshot.pins?.[spec.side];

  if (!commit) return;
  const text = review.text(spec.path, commit);

  return text === undefined
    ? undefined
    : { commit, text, lines: text.replace(/\r?\n$/, "").split(/\r?\n/) };
}

function rangeLines(
  lines: readonly string[],
  ranges: readonly ReviewInlineEditorRange[],
) {
  return ranges.map((range) => {
    const numbers: number[] = [];

    for (
      let n = Math.max(1, range.startLine);
      n <= Math.min(range.endLine, lines.length);
      n++
    )
      numbers.push(n);

    return numbers;
  });
}

function matcher(query: ReviewFindQuery) {
  if (!query.text) return;

  const pattern = query.isRegex
    ? query.text
    : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    return new RegExp(
      query.wholeWord ? `\\b(?:${pattern})\\b` : pattern,
      query.matchCase ? "g" : "gi",
    );
  } catch {
    return;
  }
}

function find(
  lines: readonly string[],
  ranges: number[][],
  regex: RegExp | undefined,
): Found {
  const byLine = new Map<number, Match[]>();
  let count = 0;

  if (!regex) return { byLine, count };

  for (const n of ranges.flat()) {
    const matches: Match[] = [];

    for (const match of lines[n - 1].matchAll(regex)) {
      if (match[0])
        matches.push({
          start: match.index,
          end: match.index + match[0].length,
          index: count++,
        });
    }

    if (matches.length) byLine.set(n, matches);
  }

  return { byLine, count };
}

function element(
  tag: string,
  style: stylex.StyleXStyles | false,
  text?: string,
) {
  const node = document.createElement(tag);

  if (style) node.className = stylex.props(style).className ?? "";

  if (text !== undefined) node.textContent = text;

  return node;
}

function code(
  line: string,
  tokens: readonly Token[] | undefined,
  matches: readonly Match[],
  active: number | undefined,
) {
  const list = tokens?.length ? tokens : [{ content: line }];
  const starts: number[] = [];
  let offset = 0;

  for (const token of list) {
    starts.push(offset);
    offset += token.content.length;
  }

  const cuts = [
    ...new Set([
      0,
      line.length,
      ...starts,
      ...matches.flatMap((match) => [match.start, match.end]),
    ]),
  ].sort((a, b) => a - b);

  const node = element("span", styles.code);

  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];

    if (from >= to || from >= line.length) continue;
    const token = list[starts.findLastIndex((start) => start <= from)];
    const piece = element("span", false, line.slice(from, to));

    if (token.color) piece.style.color = token.color;

    if (token.fontStyle && token.fontStyle & ITALIC)
      piece.style.fontStyle = "italic";

    if (token.fontStyle && token.fontStyle & BOLD)
      piece.style.fontWeight = "bold";

    const match = matches.find(
      (candidate) => candidate.start <= from && to <= candidate.end,
    );

    if (!match) {
      node.append(piece);
      continue;
    }

    const mark = element("mark", [
      styles.match,
      match.index === active && styles.activeMatch,
    ]);

    mark.dataset.match = String(match.index);

    if (match.index === active) mark.dataset.active = "";
    mark.append(piece);
    node.append(mark);
  }

  return node;
}

export function createWebInlineEditors(
  review: Review,
): ReviewInlineEditorFactory {
  return {
    async find(spec, query) {
      const text = source(review, spec);

      return {
        matchCount: text
          ? find(
              text.lines,
              rangeLines(text.lines, spec.ranges),
              matcher(query),
            ).count
          : 0,
      };
    },
    create(spec) {
      const text = source(review, spec);
      const ranges = text ? rangeLines(text.lines, spec.ranges) : [];
      const listeners = new Set<(height: number) => void>();
      const peek = element("div", false);
      let tokens: ThemedToken[][] | undefined;
      let found: Found = find([], [], undefined);
      let active = spec.active;
      let collapsed = false;
      let activeMatch: number | undefined;
      let disposed = false;

      const render = () => {
        peek.className =
          stylex.props(
            styles.peek,
            spec.heightMode === "capped" && styles.capped,
            active && styles.active,
            collapsed && styles.collapsed,
          ).className ?? "";

        if (!text) {
          peek.replaceChildren(
            element("div", styles.notice, "Not included in this share"),
          );

          return;
        }

        peek.replaceChildren(
          ...ranges.map((numbers) => {
            const range = element("div", styles.range);
            range.dataset.range = "";

            for (const n of numbers) {
              const row = element("div", styles.line);
              row.dataset.line = String(n);
              row.append(
                element("span", styles.gutter, String(n)),
                code(
                  text.lines[n - 1],
                  tokens?.[n - 1],
                  found.byLine.get(n) ?? [],
                  activeMatch,
                ),
              );
              range.append(row);
            }

            return range;
          }),
        );
      };

      render();
      spec.container.append(peek);
      let height = peek.offsetHeight;

      const observer = new ResizeObserver(() => {
        if (peek.offsetHeight === height) return;
        height = peek.offsetHeight;

        for (const listener of listeners) listener(height);
      });

      observer.observe(peek);

      if (text) {
        void highlight(spec.path, text.commit, text.text).then(
          (highlighted) => {
            if (disposed || !highlighted) return;
            tokens = highlighted;
            render();
          },
        );
      }

      return {
        get height() {
          return height;
        },
        setActive(next) {
          active = next;
          render();
        },
        setCollapsed(next) {
          collapsed = next;
          render();
        },
        onDidChangeHeight(listener) {
          listeners.add(listener);

          return { dispose: () => listeners.delete(listener) };
        },
        onDidError: () => ({ dispose() {} }),
        async setFindQuery(query) {
          found = text
            ? find(text.lines, ranges, matcher(query))
            : find([], [], undefined);
          activeMatch = undefined;
          render();

          return { matchCount: found.count };
        },
        revealFindMatch(index) {
          activeMatch = index;
          render();

          const mark = peek.querySelector<HTMLElement>(
            `mark[data-match="${index}"]`,
          );

          if (!mark) return;
          peek.scrollTop =
            mark.offsetTop - (peek.clientHeight - mark.offsetHeight) / 2;
          peek.scrollLeft =
            mark.offsetLeft - (peek.clientWidth - mark.offsetWidth) / 2;
        },
        clearActiveFindMatch() {
          activeMatch = undefined;
          render();
        },
        clearFind() {
          found = find([], [], undefined);
          activeMatch = undefined;
          render();
        },
        dispose() {
          disposed = true;
          observer.disconnect();
          listeners.clear();
          peek.remove();
        },
      };
    },
  };
}
