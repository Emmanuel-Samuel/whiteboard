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
import { testTheme } from "./test-theme";

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
    testTheme().theme,
  );

  expect(await view.files()).toEqual([modified]);
});

it("renders the diff of each file from both texts", async () => {
  const errors: string[] = [];

  const factory = createWebDiffView(
    review([modified]),
    () => "unified",
    noLayoutChanges,
    testTheme().theme,
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
  expect(errors).toEqual([]);
});

it("reports a file with no text on either side through onDidError once", async () => {
  const errors: string[] = [];

  const factory = createWebDiffView(
    review([modified], () => undefined),
    () => "split",
    noLayoutChanges,
    testTheme().theme,
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
    testTheme().theme,
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
    testTheme().theme,
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
    testTheme().theme,
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

function colorSchemes(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>("[data-diff-file] *"),
  ].flatMap((element) =>
    element.shadowRoot ? [getComputedStyle(element).colorScheme] : [],
  );
}

it("follows theme changes", async () => {
  const themed = testTheme("dark");

  const factory = createWebDiffView(
    review([modified]),
    () => "split",
    noLayoutChanges,
    themed.theme,
  );

  const { container, view } = mount(({ container }) =>
    factory.create({ container }),
  );

  expect(await settled(() => colorSchemes(container).includes("dark"))).toBe(
    true,
  );

  act(() => themed.set("light"));

  expect(await settled(() => colorSchemes(container).join() === "light")).toBe(
    true,
  );

  view.dispose();
  expect(themed.listeners.size).toBe(0);
});

it("lists files missing from the share as rows, not links", async () => {
  const factory = createWebDiffView(
    review([modified, { ...modified, path: "src/gone.ts" }], (path, commit) =>
      path === "src/a.ts"
        ? commit === B
          ? "const kept = 1;\n"
          : "const kept = 1;\nconst added = 2;\n"
        : undefined,
    ),
    () => "unified",
    noLayoutChanges,
    testTheme().theme,
  );

  const { tree } = mount(({ container, tree }) =>
    factory.create({ container, fileTreeContainer: tree }),
  );

  await settled(() => tree.textContent?.includes("src/gone.ts"));
  const missing = tree.querySelector("[data-missing-file]");

  expect(missing?.textContent).toContain("src/gone.ts");
  expect(missing?.textContent).toContain("Not included in this share");
  expect(missing?.closest("button")).toBeNull();
  expect(
    [...tree.querySelectorAll("button")].map((button) => button.textContent),
  ).toEqual([expect.stringContaining("src/a.ts")]);
});

const engineUrl = new URL(
  "./structural/engine/diffr_web_bg.wasm.gz",
  import.meta.url,
).href;

function structuralSection(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    '[data-diff-file="src/a.ts"][data-structural]',
  );
}

it("replaces a file's textual diff with diffr's structural one", async ({
  skip,
}) => {
  if (!(await fetch(engineUrl, { method: "HEAD" })).ok)
    skip("The diffr engine is not built into web/structural/engine.");

  const factory = createWebDiffView(
    review([modified]),
    () => "split",
    noLayoutChanges,
    testTheme().theme,
    { structural: { engineUrl } },
  );

  const { container } = mount(({ container }) => factory.create({ container }));

  const section = await settled(() => structuralSection(container));

  expect(section && shadowText(section)).toContain("const added = 2;");
  expect(diffTypes(container)).toEqual(["split"]);
});

it("keeps the textual diff when the engine cannot load", async () => {
  const factory = createWebDiffView(
    review([modified]),
    () => "unified",
    noLayoutChanges,
    testTheme().theme,
    {
      structural: {
        engineUrl: new URL("./missing.wasm", import.meta.url).href,
      },
    },
  );

  const { container } = mount(({ container }) => factory.create({ container }));

  await settled(() => rendered(container).includes("const added = 2;"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(structuralSection(container)).toBeNull();
  expect(rendered(container)).toContain("const added = 2;");
});
