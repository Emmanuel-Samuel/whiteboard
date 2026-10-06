import { settled } from "@canvas/fixture-review-bridge";
import type {
  ReviewFindQuery,
  ReviewInlineEditorSpec,
} from "@dev.fast/review-protocol";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { afterEach, expect, it } from "vitest";

import { createWebInlineEditors } from "./inline-editors";
import { testTheme } from "./test-theme";

const B = "b".repeat(40);

const H = "a".repeat(40);

const OTHER = "c".repeat(40);

const TEXT = "line1\nline2\nline3\nline4\nline5\n";

const snapshot: SharedSnapshot = {
  reviewId: "review-1",
  version: 1,
  title: "Shared",
  pins: { repositoryId: "r", base: B, head: H },
  document: [],
  createdAt: "2026-10-06T00:00:00.000Z",
};

const editors = createWebInlineEditors(
  {
    snapshot,
    text: (path, commit) =>
      (commit === H && path === "src/a.ts") ||
      (commit === OTHER && path === "src/b.ts")
        ? TEXT
        : undefined,
  },
  testTheme().theme,
);

const query: ReviewFindQuery = {
  text: "line",
  matchCase: false,
  wholeWord: false,
  isRegex: false,
};

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

function spec(
  overrides: Partial<ReviewInlineEditorSpec> = {},
  attached = true,
): ReviewInlineEditorSpec {
  const container = document.createElement("div");
  containers.push(container);

  if (attached) document.body.append(container);

  return {
    container,
    path: "src/a.ts",
    title: "a",
    side: "head",
    ranges: [{ startLine: 2, endLine: 3 }],
    heightMode: "content",
    active: false,
    ...overrides,
  };
}

it("renders only the requested ranges with real line numbers", async () => {
  const { container, ...rest } = spec();
  const handle = editors.create({ container, ...rest });

  await settled(() => container.querySelector("[data-line='3']"));
  expect(container.textContent).toContain("line2");
  expect(container.textContent).toContain("line3");
  expect(container.textContent).not.toContain("line1");
  expect(container.textContent).not.toContain("line4");
  expect(container.querySelector("[data-line='1']")).toBeNull();
  expect(handle.height).toBeGreaterThan(0);
  expect(
    await settled(() =>
      container.querySelector("[data-line='2'] span[style*='color']"),
    ),
  ).not.toBeNull();
  handle.dispose();
});

it("reports height changes once rendered", async () => {
  const { container, ...rest } = spec({}, false);
  const handle = editors.create({ container, ...rest });
  const heights: number[] = [];
  handle.onDidChangeHeight((height) => heights.push(height));

  expect(handle.height).toBe(0);
  document.body.append(container);

  expect(await settled(() => heights.at(-1))).toBeGreaterThan(0);
  expect(handle.height).toBe(heights.at(-1));
  handle.dispose();
});

it("finds matches inside the ranges", async () => {
  const handle = editors.create(spec());

  expect((await handle.setFindQuery(query)).matchCount).toBe(2);
  handle.revealFindMatch(1);

  const active = await settled(
    () => handle && document.querySelector("mark[data-active]"),
  );

  expect(active?.closest("[data-line]")?.getAttribute("data-line")).toBe("3");
  handle.clearFind();
  expect(document.querySelector("mark")).toBeNull();
  handle.dispose();
});

it("shows a notice when the text is not in the share", async () => {
  const { container, ...rest } = spec({ path: "src/missing.ts" });
  const handle = editors.create({ container, ...rest });

  expect(container.textContent).toContain("Not included in this share");
  expect(handle.height).toBeGreaterThan(0);
  expect((await handle.setFindQuery(query)).matchCount).toBe(0);
  handle.dispose();
});

it("reads an anchor with its own pins by commit", async () => {
  const { container, ...rest } = spec({
    path: "src/b.ts",
    pins: { repositoryId: "r", head: OTHER },
  });

  const handle = editors.create({ container, ...rest });

  await settled(() => container.querySelector("[data-line='2']"));
  expect(container.textContent).toContain("line2");
  handle.dispose();
});

it("find() without an editor counts matches", async () => {
  expect(
    await editors.find(
      {
        path: "src/a.ts",
        side: "head",
        ranges: [{ startLine: 1, endLine: 4 }],
      },
      query,
    ),
  ).toEqual({ matchCount: 4 });
  expect(
    await editors.find(
      {
        path: "src/a.ts",
        side: "base",
        ranges: [{ startLine: 1, endLine: 4 }],
      },
      query,
    ),
  ).toEqual({ matchCount: 0 });
});

function sided(base: string) {
  return createWebInlineEditors(
    {
      snapshot,
      text: (path, commit) =>
        path === "src/a.ts" ? (commit === B ? base : TEXT) : undefined,
    },
    testTheme().theme,
  );
}

function blocks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-range]")].map(
    (range) => ({
      side: range.dataset.side,
      label: range.querySelector("[data-side-label]")?.textContent,
      lines: [...range.querySelectorAll("[data-line] > :last-child")].map(
        (code) => code.textContent,
      ),
    }),
  );
}

it("reads each range from its own side", async () => {
  const { container, ...rest } = spec({
    ranges: [
      { startLine: 2, endLine: 3, side: "base" },
      { startLine: 3, endLine: 4, side: "head" },
    ],
  });

  const handle = sided("old1\nold2\nold3\n").create({ container, ...rest });

  await settled(() => container.querySelector("[data-line='4']"));
  expect(blocks(container)).toEqual([
    { side: "base", label: "Base", lines: ["old2", "old3"] },
    { side: "head", label: undefined, lines: ["line3", "line4"] },
  ]);
  handle.dispose();
});

it("shows lines that read the same on both sides once", async () => {
  const { container, ...rest } = spec({
    ranges: [
      { startLine: 2, endLine: 3, side: "base" },
      { startLine: 2, endLine: 3, side: "head" },
    ],
  });

  const handle = sided(TEXT).create({ container, ...rest });

  await settled(() => container.querySelector("[data-line='3']"));
  expect(container.querySelectorAll("[data-line='2']")).toHaveLength(1);
  expect(container.querySelectorAll("[data-line='3']")).toHaveLength(1);
  expect(container.querySelector("[data-side-label]")).toBeNull();
  handle.dispose();
});

it("shows identical ranges on the same side each time", async () => {
  const { container, ...rest } = spec({
    ranges: [
      { startLine: 2, endLine: 3 },
      { startLine: 2, endLine: 3 },
    ],
  });

  const handle = editors.create({ container, ...rest });

  await settled(() => container.querySelector("[data-line='3']"));
  expect(container.querySelectorAll("[data-range]")).toHaveLength(2);
  handle.dispose();
});

it("re-highlights when the theme changes", async () => {
  const themed = testTheme("dark");
  const { container, ...rest } = spec();

  const handle = createWebInlineEditors(
    { snapshot, text: () => "const answer = 1;\n" },
    themed.theme,
  ).create({ container, ...rest, ranges: [{ startLine: 1, endLine: 1 }] });

  const colors = () =>
    [...container.querySelectorAll<HTMLElement>("[data-line] span[style]")]
      .map((span) => span.style.color)
      .join();

  const dark = await settled(() => colors());
  themed.set("light");
  expect(await settled(() => colors() !== dark && colors())).toBeTruthy();
  handle.dispose();
  expect(themed.listeners.size).toBe(0);
});
