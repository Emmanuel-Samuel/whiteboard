import type { JsonValue } from "@dev.fast/review-protocol";
import { assignFreshIds, documentSchema } from "@review/review-api/document";
import { act } from "react";
import { afterEach, expect, it } from "vitest";

import { libavoidWasmUrl, settled } from "./fixture-review-bridge";
import { mountSharedReview } from "./web-entry";
import { testShareBundle } from "./web/test-share-bundle";

const tour = Object.values(
  import.meta.glob<{ default: JsonValue }>(
    "./fixtures/saved-reviews/three-minute-tour.json",
    { eager: true },
  ),
)[0]!.default;

let canvas: ReturnType<typeof mountSharedReview> | undefined;

afterEach(async () => {
  await act(async () => canvas?.dispose());
  canvas = undefined;
  document.body.replaceChildren();
});

async function mount(bundle: Awaited<ReturnType<typeof testShareBundle>>) {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    canvas = mountSharedReview(container, bundle, {
      wasmUrl: libavoidWasmUrl,
      theme: "dark",
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
