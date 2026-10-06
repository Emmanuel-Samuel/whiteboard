import { createHash } from "node:crypto";

import {
  type JsonValue,
  ReviewDiffViewFactory,
  type ReviewInlineEditorFactory,
  parseReviewAgentTraceListResponse,
} from "@dev.fast/review-protocol";
import { SHARE_FORMAT } from "@dev.fast/review-share-protocol";
import { readSharedReview } from "@review/sharing/read";
import { expect, it } from "vitest";

import { createShareBridge } from "./share-bridge";

const objects = new Map<string, Uint8Array>();

const put = (bytes: Uint8Array) => {
  const id = createHash("sha256").update(bytes).digest("hex");
  objects.set(id, bytes);

  return id;
};

const putJson = (value: JsonValue) =>
  put(new TextEncoder().encode(JSON.stringify(value)));

const pins = {
  repositoryId: "repo",
  base: "b".repeat(40),
  head: "a".repeat(40),
};

const snapshot = putJson({
  reviewId: "review-1",
  version: 3,
  title: "Shared",
  pins,
  document: [],
  createdAt: "2026-10-06T00:00:00.000Z",
});

const diff = [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }];

const map = {
  commit: pins.head,
  side: "head",
  elements: [],
  relationships: [],
  countsByElementPath: {},
  unmappedByElementPath: {},
};

const presentation = putJson({
  maps: { m1: map },
  sources: { diff: putJson(diff), commits: putJson([]), files: [] },
});

const image = put(new Uint8Array([137, 80, 78, 71]));

const review = readSharedReview({
  manifest: {
    format: SHARE_FORMAT,
    reviewId: "review-1",
    version: 3,
    title: "Shared",
    snapshot,
    presentation,
    objects: [...objects].map(([id, bytes]) => ({
      id,
      size: bytes.byteLength,
      sha256: id,
    })),
    resources: [
      { id: "shot", kind: "image", mimeType: "image/png", object: image },
    ],
    repository: { cloneUrl: "https://github.com/octo/repo.git" },
  },
  objects,
  attribution: { login: "octocat", sharedAt: 1 },
});

const stubEditors: ReviewInlineEditorFactory = {
  find: async () => ({ matchCount: 0 }),
  create: () => {
    throw new Error("unused");
  },
};

const stubDiffView: ReviewDiffViewFactory = {
  files: async () => [],
  create: () => {
    throw new Error("unused");
  },
};

const bridge = createShareBridge(review, {
  wasmUrl: "http://127.0.0.1:1/libavoid.wasm",
  theme: "dark",
  inlineEditors: stubEditors,
  diffView: stubDiffView,
});

const base = `${bridge.config.serverUrl}/reviews-api`;

const id = `shared-${review.manifest.snapshot}`;

it("serves the snapshot under a shared- id with target and shared", async () => {
  const body = await (
    await bridge.request(
      `${base}/${id}?full=true&version=${review.snapshot.version}`,
    )
  ).json();

  expect(bridge.config.reviewId).toBe(id);
  expect(body.reviewId).toBe(id);
  expect(id).toMatch(/^shared-[a-f0-9]{64}$/);
  expect((await bridge.request(`${base}/review-1?full=true`)).status).toBe(404);
  expect(body.target).toEqual({ kind: "commits", ...review.snapshot.pins });
  expect(body.shared).toEqual({
    login: "octocat",
    sharedAt: 1,
    cloneUrl: review.manifest.repository?.cloneUrl,
  });
});

it("answers the watch stream with one Result[] line and stays open", async () => {
  const response = await bridge.request(
    `${base}/watch?subscriptions=${encodeURIComponent(JSON.stringify([{ reviewId: id }]))}`,
  );

  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();

  const { value } = await reader.read();
  const [result] = JSON.parse(value!.trim());
  expect(result.value.reviewId).toBe(id);
  expect(result.value.activity).toEqual({ workingCount: 0, expiresAt: null });

  const second = Promise.race([
    reader.read().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("open"), 100)),
  ]);

  expect(await second).toBe("open");
  await reader.cancel();
});

it.each(["progress", "diff", "commits"])("answers %s", async (route) => {
  expect((await bridge.request(`${base}/${id}/${route}`)).status).toBe(200);
});

it("serves the diff summaries from the bundle", async () => {
  expect(await (await bridge.request(`${base}/${id}/diff`)).json()).toEqual(
    diff,
  );
});

it("serves maps and resources from the bundle", async () => {
  expect(await (await bridge.request(`${base}/${id}/maps/m1`)).json()).toEqual(
    map,
  );
  expect((await bridge.request(`${base}/${id}/maps/missing`)).status).toBe(404);

  const resource = await bridge.request(`${base}/${id}/resources/shot`);
  expect(resource.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await resource.arrayBuffer())).toEqual(
    objects.get(image),
  );
});

it("returns 204 for telemetry and 404 for everything else", async () => {
  expect(
    (
      await bridge.request(`${base}/${id}/telemetry/event`, {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(204);
  expect((await bridge.request(`${base}/${id}/ask/threads`)).status).toBe(404);
});

it("reports that no authoring capability is available", async () => {
  expect(
    await bridge.post({ name: "authoringCapabilities", args: {} }),
  ).toEqual({ ok: true, result: { softwareMapEnabled: false } });
});

it("answers agent traces with an empty loaded list", async () => {
  const response = await bridge.request(`${base}/${id}/agent-traces`);

  expect(response.status).toBe(200);
  expect(parseReviewAgentTraceListResponse(await response.json())).toEqual(
    expect.objectContaining({ ok: true, configured: false, sessions: [] }),
  );
});

it("honors the method and refuses writes", async () => {
  expect(
    (await bridge.request(`${base}/${id}/progress`, { method: "POST" })).status,
  ).toBe(404);
  expect((await bridge.request(`${base}/${id}/telemetry/event`)).status).toBe(
    404,
  );
});

it("answers 404 for malformed paths and undeclared objects", async () => {
  expect((await bridge.request(`${base}/${id}/maps/%E0%A4%A`)).status).toBe(
    404,
  );

  const broken = createShareBridge(
    {
      ...review,
      object: () => {
        throw new Error("undeclared");
      },
    },
    {
      wasmUrl: "",
      theme: "dark",
      inlineEditors: stubEditors,
      diffView: stubDiffView,
    },
  );

  expect((await broken.request(`${base}/${id}/resources/shot`)).status).toBe(
    404,
  );
});

it("stops following the host theme once disposed", () => {
  const listeners = new Set<(theme: "dark" | "light") => void>();

  const themed = createShareBridge(review, {
    wasmUrl: "",
    theme: "dark",
    onDidChangeTheme(listener) {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },
    inlineEditors: stubEditors,
    diffView: stubDiffView,
  });

  for (const listener of listeners) listener("light");
  expect(themed.currentTheme()).toBe("light");
  themed.dispose();
  expect(listeners.size).toBe(0);
});
