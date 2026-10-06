import { createHash } from "node:crypto";

import {
  MAX_SHARE_BYTES,
  MAX_SHARE_MANIFEST_BYTES,
  MAX_SHARE_OBJECT_BYTES,
  SHARE_FORMAT,
  type ShareManifest,
  shareManifestSchema,
  sharePathSchema,
} from "@dev.fast/review-share-protocol";
import { sourceAnchors } from "@review/lens-selection.js";
import { markdownNodes, parseMarkdown } from "@review/markdown.js";
import { lensSelections } from "@review/review-api/diff-lenses.js";
import { ReviewInputError } from "@review/review-api/document.js";
import {
  type Pins,
  anchorPins,
  checkReferences,
  documentSchema,
  elements,
  hasCodeReferences,
  resourceReference,
  resourceReferences,
  sourceReferences,
} from "@review/review-api/document.js";
import type { LocalReviewData } from "@review/review-api/local-data.js";
import type { ReviewStore, Snapshot } from "@review/review-api/store.js";
import { z } from "zod";

import type { ShareSources } from "./schemas.js";

export interface ShareBundle {
  manifest: ShareManifest;
  objects: Map<string, Uint8Array>;
  attribution?: { login: string; sharedAt: number };
}

export type ShareExportStore = Pick<ReviewStore, "read" | "resource">;

export type ShareExportData = Pick<
  LocalReviewData,
  "map" | "validateResource" | "validateSource" | "changes" | "commits" | "file"
>;

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateShareSources(
  snapshot: Pick<Snapshot, "pins" | "document" | "lenses">,
) {
  if (!snapshot.pins && hasCodeReferences(snapshot))
    throw new ReviewInputError(
      "Reviews with code references need source pins before sharing.",
      409,
    );
}

/** Freeze one stored version before any asynchronous source reads. */
export async function exportShare(input: {
  store: ShareExportStore;
  data: ShareExportData;
  reviewId: string;
  version?: number;
  repository?: ShareManifest["repository"];
}): Promise<ShareBundle> {
  // A share is the finished document: what edit last touched it stays home.
  const {
    target,
    kind: _kind,
    staleSources: _staleSources,
    sourceUnavailable: _sourceUnavailable,
    lastEdit: _lastEdit,
    trashedAt: _trashedAt,
    ...snapshot
  } = structuredClone(input.store.read(input.reviewId, input.version));

  if (target?.kind === "worktree")
    throw new ReviewInputError("Pin this review to commits before sharing it.");

  documentSchema.parse(snapshot.document);
  checkReferences(snapshot.document);
  const objects = new Map<string, Uint8Array>();
  let totalBytes = 0;

  const add = (bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_SHARE_OBJECT_BYTES)
      throw new ReviewInputError("A shared object exceeds the upload limit.");
    const id = digestBytes(bytes);

    if (!objects.has(id)) {
      totalBytes += bytes.byteLength;

      if (totalBytes > MAX_SHARE_BYTES)
        throw new ReviewInputError("Review exceeds the sharing limit.");
      objects.set(id, Uint8Array.from(bytes));
    }

    return id;
  };

  const json = <Value>(value: Value) => add(Buffer.from(JSON.stringify(value)));
  const resources: ShareManifest["resources"] = [];
  const maps: Record<string, Awaited<ReturnType<LocalReviewData["map"]>>> = {};

  // Lens ranges travel with the snapshot and must resolve at its pins too.
  const sources = [
    ...sourceReferences(snapshot.document),
    ...lensSelections(snapshot.lenses ?? []).flatMap((selection) =>
      sourceAnchors(selection.source).map((source) => ({
        ...selection,
        source,
        peek: false,
      })),
    ),
  ];

  const pins = snapshot.pins;

  validateShareSources(snapshot);

  if (Boolean(pins) !== Boolean(input.repository))
    throw new ReviewInputError("Shared source pins require a repository.", 409);

  for (const block of elements(snapshot.document)) {
    if (block.type !== "markdown") continue;

    for (const node of markdownNodes(parseMarkdown(block.markdown)))
      if (node.type === "image")
        throw new ReviewInputError(
          "Convert Markdown images to managed image blocks before sharing.",
        );
  }

  for (const block of resourceReferences(snapshot.document)) {
    await input.data.validateResource(pins, block);

    const reference = resourceReference(block);

    if (
      !reference ||
      resources.some((resource) => resource.id === reference.id)
    )
      continue;
    const { id } = reference;
    const resource = input.store.resource(id);
    resources.push({
      id,
      kind: z.enum(["image", "trace", "map"]).parse(resource.kind),
      mimeType: z
        .enum(["image/png", "application/json"])
        .parse(resource.mimeType),
      object: add(resource.data),
    });

    if (block.type === "software_map") {
      const map = await input.data.map(pins, id);
      Object.defineProperty(maps, id, { value: map, enumerable: true });

      for (const element of map.elements)
        for (const range of element.sourceRanges ?? [])
          sources.push({
            id: `${id}:${element.id}`,
            source: { ...range, side: map.side },
          });
    }
  }

  for (const reference of sources)
    await input.data.validateSource(
      anchorPins(reference.source, pins),
      reference.source,
      { peek: reference.peek ?? false },
    );

  let sourcesIndex: ShareSources | undefined;

  if (pins) {
    const summaries = await input.data.changes(pins);
    const wanted = new Map<string, { path: string; at: Pins }>();

    const want = (path: string, at: Pins, commit: string) =>
      wanted.set(`${commit}\0${path}`, {
        path,
        at: { repositoryId: at.repositoryId, base: commit, head: commit },
      });

    for (const summary of summaries) {
      if (summary.binary) continue;

      if (summary.status !== "added")
        want(summary.previousPath ?? summary.path, pins, pins.base);

      if (summary.status !== "deleted") want(summary.path, pins, pins.head);
    }

    for (const { source } of sources) {
      const at = anchorPins(source, pins);
      want(source.file, at, at[source.side ?? "head"]);
    }

    const files: ShareSources["files"] = [];

    for (const { path, at } of wanted.values()) {
      if (!sharePathSchema.safeParse(path).success) continue;

      const text = await readText(input.data, at, path);

      if (text === undefined) continue;

      const bytes = Buffer.from(text);

      if (bytes.byteLength > MAX_SHARE_OBJECT_BYTES) continue;

      files.push({ path, commit: at.head, object: add(bytes) });
    }

    sourcesIndex = {
      diff: json(summaries),
      commits: json(await input.data.commits(pins)),
      files,
    };
  }

  const snapshotId = json(snapshot);

  const presentationId = json({
    maps,
    ...(sourcesIndex && { sources: sourcesIndex }),
  });

  const manifest = shareManifestSchema.parse({
    format: SHARE_FORMAT,
    reviewId: snapshot.reviewId,
    version: snapshot.version,
    title: snapshot.title,
    snapshot: snapshotId,
    presentation: presentationId,
    objects: [...objects].map(([id, bytes]) => ({
      id,
      sha256: id,
      size: bytes.byteLength,
    })),
    resources,
    repository: input.repository,
  });

  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_SHARE_MANIFEST_BYTES)
    throw new ReviewInputError("The share manifest exceeds the upload limit.");

  return { manifest, objects };
}

/** Missing sides and binary files are not shared. */
async function readText(data: ShareExportData, pins: Pins, file: string) {
  try {
    return (await data.file(pins, "head", file)).text;
  } catch (error) {
    if (error instanceof ReviewInputError) return undefined;
    throw error;
  }
}
