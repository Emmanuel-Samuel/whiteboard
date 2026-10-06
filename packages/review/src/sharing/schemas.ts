import {
  objectIdSchema,
  sharePathSchema,
} from "@dev.fast/review-share-protocol";
import { lensSchema } from "@review/review-api/diff-lenses.js";
import { documentSchema, pinsSchema } from "@review/review-api/document.js";
import {
  normalizedSoftwareElementSchema,
  normalizedSoftwareRelationshipSchema,
} from "@review/software-map-model.js";
import { z } from "zod";

export const sharedSnapshotSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1),
  pins: pinsSchema
    .extend({
      base: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    })
    .optional(),
  document: documentSchema,
  lenses: z.array(lensSchema).optional(),
  createdAt: z.string(),
  origin: z
    .strictObject({
      branch: z.string().optional(),
      baseRef: z.string().optional(),
      pullRequestNumber: z.number().int().positive().optional(),
      pullRequestUrl: z.string().optional(),
      pullRequestTitle: z.string().optional(),
      revision: z.string().optional(),
    })
    .optional(),
});

const count = z.number().int().nonnegative();

const counts = z.strictObject({ additions: count, deletions: count });

export const mapSchema = z.strictObject({
  commit: z.string(),
  side: z.enum(["base", "head"]),
  elements: z.array(normalizedSoftwareElementSchema),
  relationships: z.array(normalizedSoftwareRelationshipSchema),
  countsByElementPath: z.record(z.string(), counts),
  unmappedByElementPath: z.record(
    z.string(),
    counts.extend({
      files: z.array(
        counts.extend({
          file: z.string(),
          hunks: z.array(
            z.strictObject({
              startLine: count,
              lines: z.array(
                z.strictObject({
                  kind: z.enum(["add", "remove"]),
                  oldLine: count.nullable(),
                  newLine: count.nullable(),
                  text: z.string(),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export const shareSourcesSchema = z.strictObject({
  diff: objectIdSchema,
  commits: objectIdSchema,
  files: z.array(
    z.strictObject({
      path: sharePathSchema,
      commit: commitSchema,
      object: objectIdSchema,
    }),
  ),
});

export const sharePresentationSchema = z.strictObject({
  maps: z.record(z.string(), mapSchema),
  sources: shareSourcesSchema.optional(),
});

export type SharedSnapshot = z.infer<typeof sharedSnapshotSchema>;

export type SharePresentation = z.infer<typeof sharePresentationSchema>;

export type ShareSources = z.infer<typeof shareSourcesSchema>;
