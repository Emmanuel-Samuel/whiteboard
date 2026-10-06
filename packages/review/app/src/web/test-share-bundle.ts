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

export async function testShareBundle({
  snapshot,
  presentation = { maps: {} },
  resources = [],
  repository,
  attribution,
}: {
  snapshot: SharedSnapshot;
  presentation?: SharePresentation;
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

  const putJson = (value: SharedSnapshot | SharePresentation) =>
    put(new TextEncoder().encode(JSON.stringify(value)));

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
