import type { JsonValue } from "@dev.fast/review-protocol";
import { assignFreshIds, documentSchema } from "@review/review-api/document";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";

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

type Theme = "dark" | "light";

async function mount(
  bundle: Awaited<ReturnType<typeof testShareBundle>>,
  theme: Theme = "dark",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const listeners = new Set<(theme: Theme) => void>();
  await act(async () => {
    canvas = mountSharedReview(container, bundle, {
      wasmUrl: libavoidWasmUrl,
      theme,
      onDidChangeTheme(listener) {
        listeners.add(listener);

        return { dispose: () => listeners.delete(listener) };
      },
    });
  });

  return {
    container,
    listeners,
    async setTheme(next: Theme) {
      await act(async () => {
        for (const listener of listeners) listener(next);
      });
    },
  };
}

async function peekAndDiffBundle() {
  const { sources, ...snapshot } = peekAndDiff;
  const document = documentSchema.parse(snapshot.document);
  let nextId = 0;

  for (const block of document)
    assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

  return testShareBundle({
    snapshot: { ...snapshot, document },
    sources,
    repository: { cloneUrl: "https://github.com/fixture/review.git" },
  });
}

const diffShown = (container: HTMLElement, style: string) =>
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

const openDiff = (container: HTMLElement) =>
  act(async () =>
    container.querySelector<HTMLElement>('button[aria-label="Diff"]')!.click(),
  );

it("renders a shared review from its bundle", async () => {
  const document = documentSchema.parse(tour);
  let nextId = 0;

  for (const block of document)
    assignFreshIds(block, (prefix) => `${prefix}-${++nextId}`);

  const { container } = await mount(
    await testShareBundle({
      snapshot: {
        reviewId: "6f1c2a9e-3b7d-4e1a-9c55-0d2f8a7b4e10",
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
  const { container } = await mount(
    await testShareBundle({
      snapshot: {
        reviewId: "notes",
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

it("shows a code peek and the Diff tab in both layouts through the default menu", async () => {
  localStorage.removeItem("review-web:diff-layout");
  const { container } = await mount(await peekAndDiffBundle());

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

  await openDiff(container);
  expect(await diffShown(container, "split")).toBe(true);
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/diff-split.png",
  });

  const settings = container.querySelector<HTMLElement>(
    'button[aria-label="Diff settings"]',
  )!;

  await act(async () => settings.click());

  const menu = await settled(() =>
    container.querySelector<HTMLElement>('[role="menu"]'),
  );

  const unified = [
    ...menu!.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ].find((item) => item.textContent?.includes("Unified"));

  await act(async () => unified!.click());

  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(await diffShown(container, "single")).toBe(true);
  expect(container.querySelector("[data-block-error]")).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain("older version");
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/diff-unified.png",
  });

  await act(async () => settings.click());
  expect(
    await settled(() => container.querySelector('[role="menu"]')),
  ).not.toBeNull();
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(container.querySelector('[role="menu"]')).toBeNull();
}, 30_000);

it("switches a shared review to the light theme without errors", async () => {
  localStorage.removeItem("review-web:diff-layout");

  const { container, listeners, setTheme } = await mount(
    await peekAndDiffBundle(),
  );

  await settled(() =>
    container.querySelector(
      '[data-code-rendering="inline-editor"] [data-line="3"] span[style]',
    ),
  );
  await setTheme("light");

  expect(container.dataset.reviewTheme).toBe("light");
  expect(
    await settled(() =>
      [
        ...container.querySelectorAll<HTMLElement>(
          '[data-code-rendering="inline-editor"] span[style]',
        ),
      ].some((span) => span.style.color),
    ),
  ).toBe(true);
  expect(container.querySelector("[data-block-error]")).toBeNull();
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/peek-light.png",
  });

  await openDiff(container);
  expect(await diffShown(container, "split")).toBe(true);
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-diff-file] *")].flatMap(
      (element) =>
        element.shadowRoot ? [getComputedStyle(element).colorScheme] : [],
    ),
  ).not.toContain("dark");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await page.screenshot({
    path: "__screenshots__/peek-and-diff/diff-light.png",
  });

  await act(async () => canvas?.dispose());
  canvas = undefined;
  expect(listeners.size).toBe(0);
}, 30_000);
