import type {
  ReviewCanvasBridge,
  ReviewDiffLayout,
  ReviewDiffLayoutScope,
  ReviewDiffViewFactory,
  ReviewDisposable,
  ReviewInlineEditorFactory,
  ReviewStreamLine,
} from "@dev.fast/review-protocol";
import type { Snapshot } from "@review/review-api/store";
import type { SharedReview } from "@review/sharing/read";

import { shareProgress } from "./share-progress";

type Theme = "dark" | "light";

export interface ShareBridgeOptions {
  wasmUrl: string;
  theme: Theme;
  onDidChangeTheme?: (listener: (theme: Theme) => void) => ReviewDisposable;
  inlineEditors: ReviewInlineEditorFactory;
  diffView: ReviewDiffViewFactory;
}

const layoutKey = (scope: ReviewDiffLayoutScope) =>
  `review-web:${scope}-layout`;

const defaultLayouts: Record<ReviewDiffLayoutScope, ReviewDiffLayout> = {
  diff: "split",
  peek: "unified",
};

/** Shared reviews are served under `shared-<id>`, like the desktop's imported shares. */
export function sharedReviewId(review: SharedReview) {
  return `shared-${review.manifest.snapshot}`;
}

/** The snapshot the bridge serves: adds `target` and `shared` like SharedReviewStore.get. */
export function servedSnapshot(review: SharedReview): Snapshot {
  const { pins } = review.snapshot;

  return {
    ...review.snapshot,
    reviewId: sharedReviewId(review),
    target: pins ? { kind: "commits", ...pins } : undefined,
    shared: {
      ...review.attribution,
      cloneUrl: review.manifest.repository?.cloneUrl,
    },
  };
}

export function createShareBridge(
  review: SharedReview,
  options: ShareBridgeOptions,
): ReviewCanvasBridge & ReviewDisposable {
  const id = sharedReviewId(review);
  const encoder = new TextEncoder();
  let theme = options.theme;
  const themeListeners = new Set<(theme: Theme) => void>();

  const layoutListeners: Record<
    ReviewDiffLayoutScope,
    Set<(layout: ReviewDiffLayout) => void>
  > = { diff: new Set(), peek: new Set() };

  let progress: ReturnType<typeof shareProgress> | undefined;

  const themeSubscription = options.onDidChangeTheme?.((next) => {
    theme = next;

    for (const listener of themeListeners) listener(next);
  });

  const listen = <T>(listeners: Set<T>, listener: T): ReviewDisposable => {
    listeners.add(listener);

    return { dispose: () => listeners.delete(listener) };
  };

  const notFound = () =>
    Response.json(
      { error: "Not available in a shared view." },
      { status: 404 },
    );

  const route = (
    method: string,
    path: string,
    query: URLSearchParams,
  ): Response => {
    if (path === "/watch" && method === "GET")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  kind: "review",
                  reviewId: id,
                  value: {
                    ...servedSnapshot(review),
                    activity: { workingCount: 0, expiresAt: null },
                    coverageRevision: 0,
                  },
                } satisfies ReviewStreamLine<Snapshot>) + "\n",
              ),
            );
          },
          cancel() {},
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );

    const [reviewId, resource, name, ...rest] = path
      .slice(1)
      .split("/")
      .map(decodeURIComponent);

    if (reviewId !== id) return notFound();

    if (resource === "telemetry")
      return method === "POST"
        ? new Response(null, { status: 204 })
        : notFound();

    if (method !== "GET") return notFound();

    if (resource === undefined)
      return query.get("full") === "true"
        ? Response.json(servedSnapshot(review))
        : notFound();

    if (name === undefined) {
      if (resource === "agent-traces")
        return Response.json({
          ok: true,
          configured: false,
          storage: "none",
          sessions: [],
        });

      if (resource === "progress")
        return Response.json((progress ??= shareProgress(review)));

      if (resource === "diff") return Response.json(review.diff());

      if (resource === "commits") return Response.json(review.commits());
    }

    if (name === undefined || rest.length) return notFound();

    if (resource === "maps")
      return Object.hasOwn(review.presentation.maps, name)
        ? Response.json(review.presentation.maps[name])
        : notFound();

    if (resource === "resources") {
      const shared = review.manifest.resources.find((item) => item.id === name);

      return shared
        ? new Response(new Blob([review.object(shared.object).slice()]), {
            headers: { "content-type": shared.mimeType },
          })
        : notFound();
    }

    return notFound();
  };

  return {
    config: {
      serverUrl: "http://127.0.0.1:1",
      reviewId: id,
      token: "",
      wasmUrl: options.wasmUrl,
      appVersion: "web",
      theme: options.theme,
      host: "web",
    },
    inlineEditors: options.inlineEditors,
    diffView: options.diffView,
    async request(url, init) {
      const { pathname, searchParams } = new URL(url);
      const prefix = pathname.indexOf("/reviews-api");

      if (prefix === -1) return notFound();

      try {
        return route(
          (init?.method ?? "GET").toUpperCase(),
          pathname.slice(prefix + "/reviews-api".length),
          searchParams,
        );
      } catch {
        return notFound();
      }
    },
    async post(request) {
      return request.name === "authoringCapabilities"
        ? { ok: true, result: { softwareMapEnabled: false } }
        : { ok: true };
    },
    subscribe: () => ({ dispose() {} }),
    currentTheme: () => theme,
    onDidChangeTheme: (listener) => listen(themeListeners, listener),
    currentDiffLayout(scope) {
      try {
        const stored = globalThis.localStorage?.getItem(layoutKey(scope));

        if (stored === "split" || stored === "unified") return stored;
      } catch {}

      return defaultLayouts[scope];
    },
    async setDiffLayout(scope, layout) {
      try {
        globalThis.localStorage?.setItem(layoutKey(scope), layout);
      } catch {}

      for (const listener of layoutListeners[scope]) listener(layout);
    },
    onDidChangeDiffLayout: (scope, listener) =>
      listen(layoutListeners[scope], listener),
    ready() {},
    dispose() {
      themeSubscription?.dispose();
      themeListeners.clear();
      layoutListeners.diff.clear();
      layoutListeners.peek.clear();
    },
  };
}
