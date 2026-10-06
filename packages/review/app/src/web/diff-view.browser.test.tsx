import { settled } from "@canvas/fixture-review-bridge";
import type {
  ReviewDiffLayout,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import type { ShareDiffFileSummary } from "@review/sharing/read";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { act } from "react";
import { afterEach, expect, it } from "vitest";

import { createWebDiffView } from "./diff-view";
import { shadowText } from "./test-shadow-text";

const B = "b".repeat(40);

const H = "a".repeat(40);

const pins = { repositoryId: "r", base: B, head: H };

const snapshot: SharedSnapshot = {
  reviewId: "review-1",
  version: 1,
  title: "Shared",
  pins,
  document: [],
  createdAt: "2026-10-06T00:00:00.000Z",
};

const modified: ShareDiffFileSummary = {
  path: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
};

function review(
  files: ShareDiffFileSummary[],
  text: (path: string, commit: string) => string | undefined = (_, commit) =>
    commit === B ? "const kept = 1;\n" : "const kept = 1;\nconst added = 2;\n",
) {
  return { snapshot, diff: () => files, text };
}

const noLayoutChanges = () => ({ dispose() {} });

const cleanup: (() => void)[] = [];

afterEach(async () => {
  await act(async () => {
    for (const run of cleanup.splice(0)) run();
    await new Promise((resolve) => setTimeout(resolve));
  });
});

function mount(
  handle: (spec: {
    container: HTMLElement;
    tree: HTMLElement;
  }) => ReviewDiffViewHandle,
) {
  const container = document.createElement("div");
  const tree = document.createElement("div");
  container.style.height = "400px";
  container.style.overflow = "auto";
  document.body.append(container, tree);
  let view!: ReviewDiffViewHandle;
  act(() => {
    view = handle({ container, tree });
  });
  cleanup.push(() => {
    view.dispose();
    container.remove();
    tree.remove();
  });

  return { container, tree, view };
}

function rendered(container: HTMLElement) {
  return [...container.querySelectorAll("[data-diff-file]")]
    .map(shadowText)
    .join("");
}

it("lists files", async () => {
  const view = createWebDiffView(
    review([modified]),
    () => "unified",
    noLayoutChanges,
  );

  expect(await view.files()).toEqual([modified]);
});

it("renders the diff of each file from both texts", async () => {
  const errors: string[] = [];

  const factory = createWebDiffView(
    review([modified]),
    () => "unified",
    noLayoutChanges,
  );

  const { container, tree, view } = mount(({ container, tree }) =>
    factory.create({ container, fileTreeContainer: tree }),
  );

  view.onDidError((message) => errors.push(message));

  await settled(() => rendered(container).includes("const added = 2;"));
  expect(rendered(container)).toContain("const added = 2;");
  expect(tree.textContent).toContain("src/a.ts");
  expect(tree.textContent).toContain("+1");
  expect(() => view.revealFile?.("src/a.ts")).not.toThrow();
  expect(
    view.sourceOffset?.({
      side: "head",
      file: "src/a.ts",
      fromLine: 1,
      toLine: 1,
    }),
  ).toBeTypeOf("number");
  expect(errors).toEqual([]);
});

it("reports a file with no text on either side through onDidError once", async () => {
  const errors: string[] = [];

  const factory = createWebDiffView(
    review([modified], () => undefined),
    () => "split",
    noLayoutChanges,
  );

  const { view } = mount(({ container }) => factory.create({ container }));
  view.onDidError((message) => errors.push(message));

  await settled(() => errors.length);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(errors).toEqual(["src/a.ts is not included in this share."]);
});

it("shows a binary file as one row", async () => {
  const errors: string[] = [];

  const factory = createWebDiffView(
    review(
      [
        {
          path: "img/logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ],
      () => undefined,
    ),
    () => "unified",
    noLayoutChanges,
  );

  const { container, view } = mount(({ container }) =>
    factory.create({ container }),
  );

  view.onDidError((message) => errors.push(message));

  await settled(() => rendered(container).includes("Binary file"));
  expect(rendered(container)).toContain("Binary file");
  expect(errors).toEqual([]);
});

it("does not throw revealing a file that is not in the diff", () => {
  const factory = createWebDiffView(
    review([modified]),
    () => "unified",
    noLayoutChanges,
  );

  const { view } = mount(({ container }) => factory.create({ container }));

  expect(() => view.revealFile?.("src/missing.ts")).not.toThrow();
});

function diffTypes(container: HTMLElement) {
  return [...container.querySelectorAll("*")].flatMap((element) =>
    [
      ...(element.shadowRoot?.querySelectorAll<HTMLElement>(
        "[data-diff-type]",
      ) ?? []),
    ].map((node) => node.dataset.diffType),
  );
}

it("re-renders with the new style when the layout changes", async () => {
  const listeners = new Set<(layout: ReviewDiffLayout) => void>();

  const factory = createWebDiffView(
    review([modified]),
    () => "split",
    (listener) => {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },
  );

  const { container, view } = mount(({ container }) =>
    factory.create({ container }),
  );

  await settled(() => diffTypes(container).includes("split"));
  expect(diffTypes(container)).toContain("split");

  act(() => {
    for (const listener of listeners) listener("unified");
  });

  await settled(() => diffTypes(container).includes("single"));
  expect(diffTypes(container)).toEqual(["single"]);

  view.dispose();
  expect(listeners.size).toBe(0);
});
