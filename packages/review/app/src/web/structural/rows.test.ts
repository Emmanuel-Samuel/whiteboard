import { expect, it } from "vitest";

import { parseDiffed } from "./diffed";
import fixture from "./fixtures/a.json";
import { lineAt } from "./lines";
import { defaultCollapsed } from "./regions";
import { type Row, buildRows, prepare } from "./rows";

function rows(layout: "split" | "unified"): Row[] {
  const { event, lines, syntax } = parseDiffed(JSON.stringify(fixture));

  if (event.diff?.type !== "text") throw new Error("expected a text diff");

  return buildRows(
    prepare(event.diff, lines, syntax),
    layout,
    defaultCollapsed(event.diff),
  );
}

const line = (side: 0 | 1, number: number, kind: string) =>
  expect.objectContaining({ side, line: number, kind });

it("aligns unchanged lines side by side and leaves the added line alone", () => {
  expect(rows("split")).toEqual([
    expect.objectContaining({
      left: line(0, 0, "context"),
      right: line(1, 0, "context"),
    }),
    expect.objectContaining({
      left: line(0, 1, "context"),
      right: line(1, 1, "context"),
    }),
    expect.objectContaining({
      left: line(0, 2, "context"),
      right: line(1, 2, "context"),
    }),
    {
      type: "line",
      key: "_:3",
      left: undefined,
      right: line(1, 3, "change-addition"),
    },
  ]);
});

it("lists the added line after the unchanged ones in a unified layout", () => {
  const cells = rows("unified").map((row) =>
    row.type === "line" && "cell" in row ? row.cell : undefined,
  );

  expect(cells).toEqual([
    expect.objectContaining({ side: 1, line: 0, alt: 0 }),
    expect.objectContaining({ side: 1, line: 1, alt: 1 }),
    expect.objectContaining({ side: 1, line: 2, alt: 2 }),
    line(1, 3, "change-addition"),
  ]);
});

it("keeps the text of the added line", () => {
  const { lines } = parseDiffed(JSON.stringify(fixture));

  expect(lineAt(lines[1], 3)).toBe("const added = 2;");
});
