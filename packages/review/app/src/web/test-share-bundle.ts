import type { JsonValue } from "@dev.fast/review-protocol";
import { SHARE_FORMAT } from "@dev.fast/review-share-protocol";
import type { ShareBundle } from "@review/sharing/export";
import type {
  SharePresentation,
  SharedSnapshot,
} from "@review/sharing/schemas";

export interface TestShareResource {
  id: string;
  kind: "image" | "trace" | "map";
  mimeType: "image/png" | "application/json";
  bytes: Uint8Array;
}

export interface TestShareSources {
  diff: JsonValue;
  commits: JsonValue;
  files: { path: string; commit: string; text: string }[];
}

export async function testShareBundle({
  snapshot,
  presentation = { maps: {} },
  sources,
  resources = [],
  repository,
  attribution,
}: {
  snapshot: SharedSnapshot;
  presentation?: SharePresentation;
  sources?: TestShareSources;
  resources?: TestShareResource[];
  repository?: { cloneUrl: string };
  attribution?: ShareBundle["attribution"];
}): Promise<ShareBundle> {
  const objects = new Map<string, Uint8Array>();

  const put = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice());

    const id = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    objects.set(id, bytes);

    return id;
  };

  const encode = (text: string) => new TextEncoder().encode(text);

  const putJson = (value: SharedSnapshot | SharePresentation | JsonValue) =>
    put(encode(JSON.stringify(value)));

  if (sources)
    presentation = {
      ...presentation,
      sources: {
        diff: await putJson(sources.diff),
        commits: await putJson(sources.commits),
        files: await Promise.all(
          sources.files.map(async ({ path, commit, text }) => ({
            path,
            commit,
            object: await put(encode(text)),
          })),
        ),
      },
    };

  const manifestResources = await Promise.all(
    resources.map(async ({ bytes, ...resource }) => ({
      ...resource,
      object: await put(bytes),
    })),
  );

  return {
    manifest: {
      format: SHARE_FORMAT,
      reviewId: snapshot.reviewId,
      version: snapshot.version,
      title: snapshot.title,
      snapshot: await putJson(snapshot),
      presentation: await putJson(presentation),
      objects: [...objects].map(([id, bytes]) => ({
        id,
        size: bytes.byteLength,
        sha256: id,
      })),
      resources: manifestResources,
      ...(repository && { repository }),
    },
    objects,
    ...(attribution && { attribution }),
  };
}
