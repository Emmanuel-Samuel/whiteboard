import type { JsonValue } from "@dev.fast/review-protocol";
import { assignFreshIds, documentSchema } from "@review/review-api/document";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";

import { testCanvasUi } from "./canvas-ui-test-utils";
import { libavoidWasmUrl, settled } from "./fixture-review-bridge";
import { mountSharedReview } from "./web-entry";
import { shadowText } from "./web/test-shadow-text";
import {
  type TestShareSources,
  testShareBundle,
} from "./web/test-share-bundle";

const tour = Object.values(
  import.meta.glob<{ default: JsonValue }>(
    "./fixtures/saved-reviews/three-minute-tour.json",
    { eager: true },
  ),
)[0]!.default;

const peekAndDiff = Object.values(
  import.meta.glob<{
    default: SharedSnapshot & { sources: TestShareSources };
  }>("./fixtures/shares/peek-and-diff.json", { eager: true }),
)[0]!.default;

let canvas: ReturnType<typeof mountSharedReview> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.replaceChildren();
});

async function mount(
  bundle: Awaited<ReturnType<typeof testShareBundle>>,
  ui?: Parameters<typeof mountSharedReview>[2]["ui"],
) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mountSharedReview(container, bundle, {
      wasmUrl: libavoidWasmUrl,
      theme: "dark",
      ui,
    });
  });

  return container;
}

it("renders a shared review from its bundle", async () => {
  const document = documentSchema.parse(tour);
  let nextId = 0;

  for (const block of document)
    assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

  const container = await mount(
    await testShareBundle({
      snapshot: {
        reviewId: "shared-tour",
        version: 0,
        title: "three-minute-tour",
        pins: {
          repositoryId: "repo",
          base: "a".repeat(40),
          head: "b".repeat(40),
        },
        document,
        createdAt: "2026-10-06T00:00:00.000Z",
      },
      repository: { cloneUrl: "https://github.com/devdotfast/whiteboard.git" },
      attribution: { login: "octocat", sharedAt: 1 },
    }),
  );

  expect(
    await settled(() =>
      container.textContent?.includes("Review Desktop: three-minute tour"),
    ),
  ).toBe(true);
  expect(container.querySelector("[data-block-error]")).toBeNull();
  expect(container.textContent).not.toContain("Connection lost");
  expect(
    await settled(() =>
      container.querySelector('[aria-label="Shared by octocat"]'),
    ),
  ).not.toBeNull();
});

it("renders a markdown-only shared review without pins", async () => {
  const container = await mount(
    await testShareBundle({
      snapshot: {
        reviewId: "shared-notes",
        version: 2,
        title: "Notes",
        document: [
          { id: "intro", type: "markdown", markdown: "# Shared notes\n\nHi." },
        ],
        createdAt: "2026-10-06T00:00:00.000Z",
      },
    }),
  );

  expect(
    await settled(() => container.textContent?.includes("Shared notes")),
  ).toBe(true);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
  expect(container.querySelector("[data-block-error]")).toBeNull();
  expect(container.textContent).not.toMatch(/Connection lost|Diff/);
});

it("shows a code peek and the Diff tab in both layouts", async () => {
  localStorage.removeItem("review-web:diff-layout");
  const { sources, ...snapshot } = peekAndDiff;
  const document = documentSchema.parse(snapshot.document);
  let nextId = 0;

  for (const block of document)
    assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

  const menus = testCanvasUi();

  const container = await mount(
    await testShareBundle({
      snapshot: { ...snapshot, document },
      sources,
      repository: { cloneUrl: "https://github.com/fixture/review.git" },
    }),
    menus.ui,
  );

  const peek = await settled(() =>
    container.querySelector(
      '[data-code-rendering="inline-editor"] [data-line="3"]',
    ),
  );

  const peekRoot = peek!.closest("[data-code-rendering]")!;

  expect(
    [...peekRoot.querySelectorAll<HTMLElement>("[data-line]")].map(
      (row) => row.dataset.line,
    ),
  ).toEqual(["2", "3"]);
  expect(peekRoot.textContent?.split("line2")).toHaveLength(2);
  expect(container.textContent).not.toContain("older version");
  await page.screenshot({ path: "__screenshots__/peek-and-diff/peek.png" });

  await act(async () =>
    container.querySelector<HTMLElement>('button[aria-label="Diff"]')!.click(),
  );

  const diffShown = (style: string) =>
    settled(
      () =>
        container
          .querySelector(".diff-native-tree")
          ?.textContent?.includes("src/a.ts") &&
        [...container.querySelectorAll("[data-diff-file]")].some((section) =>
          shadowText(section).includes("const added = 2;"),
        ) &&
        [...container.querySelectorAll("[data-diff-file] *")].some((element) =>
          element.shadowRoot?.querySelector(`[data-diff-type="${style}"]`),
        ),
    );

  expect(await diffShown("split")).toBe(true);
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/diff-split.png",
  });

  await act(async () =>
    container
      .querySelector<HTMLElement>('button[aria-label="Diff settings"]')!
      .click(),
  );
  await act(() => menus.select("unified"));

  expect(await diffShown("single")).toBe(true);
  expect(container.querySelector("[data-block-error]")).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain("older version");
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/diff-unified.png",
  });
}, 30_000);
