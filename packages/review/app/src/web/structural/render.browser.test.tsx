import { afterEach, expect, it } from "vitest";

import { parseDiffed } from "./diffed";
import fixture from "./fixtures/a.json";
import { createStructuralView } from "./render";

afterEach(() => document.body.replaceChildren());

function mount(layout: "split" | "unified") {
  const view = createStructuralView(parseDiffed(JSON.stringify(fixture)), {
    path: "src/a.ts",
    status: "modified",
  });

  document.body.append(view.element);
  view.render(layout, "dark");

  return { view, root: view.element.shadowRoot! };
}

const numbers = (root: ShadowRoot, selector: string) =>
  [...root.querySelectorAll(`${selector} [data-line-number-content]`)].map(
    (node) => node.textContent,
  );

it("renders the added line with its syntax colour", () => {
  const { root } = mount("split");
  const added = root.querySelector('[data-additions] [data-line="4"]');

  expect(added?.getAttribute("data-line-type")).toBe("change-addition");
  expect(added?.textContent).toBe("const added = 2;");
  expect(added?.querySelector(".t-keyword")?.textContent).toBe("const");
  expect(root.querySelector("[data-title]")?.textContent).toBe("src/a.ts");
});

it("numbers each side's lines in a split layout", () => {
  const { root } = mount("split");

  expect(numbers(root, "[data-deletions]")).toEqual(["1", "2", "3"]);
  expect(numbers(root, "[data-additions]")).toEqual(["1", "2", "3", "4"]);
});

it("renders one column in a unified layout and follows the theme", () => {
  const { view, root } = mount("unified");

  expect(numbers(root, "[data-unified]")).toEqual(["1", "2", "3", "4"]);
  expect(
    root.querySelector("[data-diff-type]")?.getAttribute("data-diff-type"),
  ).toBe("single");
  expect(getComputedStyle(view.element).colorScheme).toBe("dark");

  view.render("split", "light");

  expect(getComputedStyle(view.element).colorScheme).toBe("light");
  expect(
    root.querySelector("[data-diff-type]")?.getAttribute("data-diff-type"),
  ).toBe("split");
});
