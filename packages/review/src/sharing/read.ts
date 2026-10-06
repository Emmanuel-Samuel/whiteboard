import { parseJsonText } from "@dev.fast/json";
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
} from "@dev.fast/review-protocol";
import {
  type ShareManifest,
  shareManifestSchema,
} from "@dev.fast/review-share-protocol";
import {
  liftFileLenses,
  migrateStoredDocument,
  migrateStoredLenses,
} from "@review/stored-document-migration.js";
import { z } from "zod";

import type { ShareBundle } from "./export.js";
import {
  type SharePresentation,
  type SharedSnapshot,
  sharePresentationSchema,
  sharedSnapshotSchema,
} from "./schemas.js";

const diffSchema = z.array(
  z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.literal(true).optional(),
  }),
);

export type ShareDiffFileSummary = z.infer<typeof diffSchema>[number];

export interface SharedReview {
  manifest: ShareManifest;
  snapshot: SharedSnapshot;
  presentation: SharePresentation;
  attribution?: { login: string; sharedAt: number };
  object(id: string): Uint8Array;
  json(id: string): JsonValue;
  diff(): ShareDiffFileSummary[];
  commits(): JsonValue;
  text(path: string, commit: string): string | undefined;
}

/** Bytes are already digest-verified by the caller (import.ts or the cloudboard client). */
export function readSharedReview(bundle: ShareBundle): SharedReview {
  const manifest = shareManifestSchema.parse(bundle.manifest);
  const declared = new Set(manifest.objects.map((object) => object.id));

  const object = (id: string) => {
    const bytes = declared.has(id) ? bundle.objects.get(id) : undefined;

    if (!bytes) throw new Error(`Shared object ${id} is missing.`);

    return bytes;
  };

  const json = (id: string) =>
    parseJsonText(new TextDecoder().decode(object(id)));

  const stored = json(manifest.snapshot);

  const snapshot = sharedSnapshotSchema.parse(
    isJsonObject(stored) && "document" in stored
      ? liftSharedLenses(stored, migrateStoredDocument(stored.document))
      : stored,
  );

  const presentation = sharePresentationSchema.parse(
    json(manifest.presentation),
  );

  const sources = presentation.sources;
  let texts: Map<string, string> | undefined;

  return {
    manifest,
    snapshot,
    presentation,
    ...(bundle.attribution && { attribution: bundle.attribution }),
    object,
    json,
    diff: () => (sources ? diffSchema.parse(json(sources.diff)) : []),
    commits: () => (sources ? json(sources.commits) : []),
    text(path, commit) {
      texts ??= new Map(
        sources?.files.map((file) => [
          `${file.commit}\0${file.path}`,
          file.object,
        ]),
      );
      const id = texts.get(`${commit}\0${path}`);

      return id === undefined
        ? undefined
        : new TextDecoder().decode(object(id));
    },
  };
}

export function liftSharedLenses(
  stored: JsonObject,
  migrated: JsonValue,
): JsonObject {
  const { document, lenses } = liftFileLenses(migrated);

  // SAFETY: migration returns the array it was given, rewritten.
  const kept = Array.isArray(stored.lenses)
    ? (migrateStoredLenses(stored.lenses) as JsonValue[])
    : [];

  return {
    ...stored,
    document,
    ...((kept.length || lenses.length) && { lenses: [...kept, ...lenses] }),
  };
}
