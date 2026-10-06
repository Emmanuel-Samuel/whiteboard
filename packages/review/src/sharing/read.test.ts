import { SHARE_FORMAT } from "@dev.fast/review-share-protocol";
import { expect, it } from "vitest";

import { type ShareBundle, digestBytes } from "./export.js";
import { readSharedReview } from "./read.js";

const head = "a".repeat(40);

const diff = [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }];

function bundle(sources: boolean): ShareBundle {
  const objects = new Map<string, Uint8Array>();

  const put = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const id = digestBytes(bytes);
    objects.set(id, bytes);

    return id;
  };

  const snapshot = put(
    JSON.stringify({
      reviewId: "review-1",
      version: 1,
      title: "Shared",
      document: [],
      createdAt: "2026-10-06T00:00:00.000Z",
    }),
  );

  const presentation = put(
    JSON.stringify({
      maps: {},
      ...(sources && {
        sources: {
          diff: put(JSON.stringify(diff)),
          commits: put("[]"),
          files: [
            { path: "a.ts", commit: head, object: put("const a = 1;\n") },
          ],
        },
      }),
    }),
  );

  return {
    manifest: {
      format: SHARE_FORMAT,
      reviewId: "review-1",
      version: 1,
      title: "Shared",
      snapshot,
      presentation,
      objects: [...objects].map(([id, bytes]) => ({
        id,
        size: bytes.byteLength,
        sha256: id,
      })),
      resources: [],
    },
    objects,
  };
}

it("reads pinned file texts and the diff from the bundle", () => {
  const review = readSharedReview(bundle(true));

  expect(review.text("a.ts", head)).toBe("const a = 1;\n");
  expect(review.text("a.ts", "b".repeat(40))).toBeUndefined();
  expect(review.diff()).toEqual(diff);
  expect(review.commits()).toEqual([]);
});

it("reads a bundle without sources as empty", () => {
  const review = readSharedReview(bundle(false));

  expect(review.diff()).toEqual([]);
  expect(review.commits()).toEqual([]);
  expect(review.text("a.ts", head)).toBeUndefined();
});

it("rejects a bundle whose snapshot object is missing", () => {
  const shared = bundle(false);
  shared.objects.delete(shared.manifest.snapshot);

  expect(() => readSharedReview(shared)).toThrow("missing");
});
