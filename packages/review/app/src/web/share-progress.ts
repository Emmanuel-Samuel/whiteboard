import { parseDiffFromFile } from "@pierre/diffs";
import {
  type AlignmentRow,
  resolveDiffSelection,
  selectionKey,
} from "@review/lens-selection";
import { anchorPins, selectionReferences } from "@review/review-api/document";
import type { ReviewProgress } from "@review/review-api/review-progress";
import type { SharedReview } from "@review/sharing/read";

type Review = Pick<SharedReview, "snapshot" | "diff" | "text">;

const lineCount = (text: string) => text.split("\n").length;

/** Pairs base and head lines the way the desktop's textual alignment does. */
function rows(base: string, head: string): AlignmentRow[] {
  const result: AlignmentRow[] = [];

  let b = 0,
    h = 0;

  const append = (baseEnd: number, headEnd: number) => {
    while (b < baseEnd || h < headEnd)
      result.push([b < baseEnd ? b++ : null, h < headEnd ? h++ : null]);
  };

  const diff = parseDiffFromFile(
    { name: "base", contents: base },
    { name: "head", contents: head },
  );

  for (const hunk of diff.hunks)
    for (const content of hunk.hunkContent)
      if (content.type === "change") {
        append(content.deletionLineIndex, content.additionLineIndex);
        append(b + content.deletions, h + content.additions);
      }

  append(lineCount(base), lineCount(head));

  return result;
}

/** Peek selections resolved from the shared texts; the share carries no coverage. */
export function shareProgress(review: Review): ReviewProgress {
  const resolvedSelections: ReviewProgress["resolvedSelections"] = {};
  const unavailableSelections: Record<string, string> = {};
  const files = review.diff();

  for (const { source } of selectionReferences(review.snapshot.document, {
    tolerant: true,
  })) {
    const key = selectionKey(source);

    try {
      const pins = anchorPins(source, review.snapshot.pins);

      const changed = source.pins
        ? undefined
        : files.find(
            (file) =>
              source.file === file.path || source.file === file.previousPath,
          );

      let alignment: AlignmentRow[];

      if (changed) {
        const base =
          changed.status === "added"
            ? ""
            : review.text(changed.previousPath ?? changed.path, pins.base);

        const head =
          changed.status === "deleted"
            ? ""
            : review.text(changed.path, pins.head);

        if (base === undefined || head === undefined)
          throw new Error("Not shared.");
        alignment = rows(base, head);
      } else {
        const text =
          review.text(source.file, pins.head) ??
          review.text(source.file, pins.base);

        if (text === undefined) throw new Error("Not shared.");
        alignment = Array.from({ length: lineCount(text) }, (_, line) => [
          line,
          line,
        ]);
      }

      resolvedSelections[key] = resolveDiffSelection(
        source,
        alignment,
        changed ?? { path: source.file },
      );
    } catch {
      unavailableSelections[key] = "Not included in this share.";
    }
  }

  return {
    complete: true,
    files: [],
    lenses: [],
    resolvedSelections,
    unavailableSelections,
  };
}
