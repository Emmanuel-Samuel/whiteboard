import { parseAnchor, selectionKey } from "@review/lens-selection";
import type { ShareDiffFileSummary } from "@review/sharing/read";
import type { SharedSnapshot } from "@review/sharing/schemas";
import { expect, it } from "vitest";

import { shareProgress } from "./share-progress";

const pins = { repositoryId: "r", base: "b".repeat(40), head: "a".repeat(40) };

const texts = new Map([
  [`${pins.base}:src/a.ts`, "line1\nline2\nline3\n"],
  [`${pins.head}:src/a.ts`, "line0\nline1\nline2\nline3\nconst added = 2;\n"],
  [`${pins.head}:src/kept.ts`, "one\ntwo\n"],
]);

const diff: ShareDiffFileSummary[] = [
  { path: "src/a.ts", status: "modified", additions: 2, deletions: 0 },
];

function progress(...anchors: string[]) {
  const snapshot: SharedSnapshot = {
    reviewId: "r1",
    version: 1,
    title: "Shared",
    pins,
    document: anchors.map((source, index) => ({
      id: `peek-${index}`,
      type: "code_peek",
      source,
    })),
    createdAt: "2026-10-06T00:00:00.000Z",
  };

  return shareProgress({
    snapshot,
    diff: () => diff,
    text: (path, commit) => texts.get(`${commit}:${path}`),
  });
}

const key = (anchor: string) => selectionKey(parseAnchor(anchor)!);

it("resolves a peek on a changed file to both aligned sides", () => {
  const result = progress("head/src/a.ts#L3-L4");

  expect(result.complete).toBe(true);
  expect(result.resolvedSelections[key("head/src/a.ts#L3-L4")]).toEqual([
    { file: "src/a.ts", side: "base", fromLine: 2, toLine: 3 },
    { file: "src/a.ts", side: "head", fromLine: 3, toLine: 4 },
  ]);
});

it("resolves a peek on an unchanged file line for line", () => {
  expect(
    progress("head/src/kept.ts#L2").resolvedSelections[
      key("head/src/kept.ts#L2")
    ],
  ).toEqual([
    { file: "src/kept.ts", side: "base", fromLine: 2, toLine: 2 },
    { file: "src/kept.ts", side: "head", fromLine: 2, toLine: 2 },
  ]);
});

it("marks a peek whose text is not shared unavailable", () => {
  const result = progress("head/src/missing.ts#L1");

  expect(result.resolvedSelections).toEqual({});
  expect(Object.keys(result.unavailableSelections ?? {})).toEqual([
    key("head/src/missing.ts#L1"),
  ]);
});
