import { settled } from "@canvas/fixture-review-bridge";
import type {
  ReviewFindQuery,
  ReviewInlineEditorSpec,
} from "@dev.fast/review-protocol";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { afterEach, expect, it } from "vitest";

import { createWebInlineEditors } from "./inline-editors";

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

const editors = createWebInlineEditors({
  snapshot,
  text: (path, commit) =>
    (commit === H && path === "src/a.ts") ||
    (commit === OTHER && path === "src/b.ts")
      ? TEXT
      : undefined,
});

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
