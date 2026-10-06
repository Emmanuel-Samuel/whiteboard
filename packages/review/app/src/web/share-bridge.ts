import type {
  ReviewCanvasBridge,
  ReviewDiffLayout,
  ReviewDiffViewFactory,
  ReviewDisposable,
  ReviewInlineEditorFactory,
} from "@dev.fast/review-protocol";
import type { Snapshot } from "@review/review-api/store";
import type { SharedReview } from "@review/sharing/read";

type Theme = "dark" | "light";

export interface ShareBridgeOptions {
  wasmUrl: string;
  theme: Theme;
  onDidChangeTheme?: (listener: (theme: Theme) => void) => ReviewDisposable;
  inlineEditors: ReviewInlineEditorFactory;
  diffView: ReviewDiffViewFactory;
}

const diffLayoutKey = "review-web:diff-layout";

/** The snapshot the bridge serves: adds `target` and `shared` like SharedReviewStore.get. */
export function servedSnapshot(review: SharedReview): Snapshot {
  const { pins } = review.snapshot;

  return {
    ...review.snapshot,
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
): ReviewCanvasBridge {
  const id = review.snapshot.reviewId;
  const encoder = new TextEncoder();
  let theme = options.theme;
  const themeListeners = new Set<(theme: Theme) => void>();
  const layoutListeners = new Set<(layout: ReviewDiffLayout) => void>();

  options.onDidChangeTheme?.((next) => {
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

  const route = (path: string, query: URLSearchParams): Response => {
    if (path === "/watch")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify([
                  {
                    value: {
                      ...servedSnapshot(review),
                      activity: { workingCount: 0, expiresAt: null },
                    },
                  },
                ]) + "\n",
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

    if (resource === undefined)
      return query.get("full") === "true"
        ? Response.json(servedSnapshot(review))
        : notFound();

    if (resource === "telemetry") return new Response(null, { status: 204 });

    if (name === undefined) {
      if (resource === "progress")
        return Response.json({ files: [], lenses: [], resolvedSelections: {} });

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
    async request(url) {
      const { pathname, searchParams } = new URL(url);
      const prefix = pathname.indexOf("/reviews-api");

      return prefix === -1
        ? notFound()
        : route(pathname.slice(prefix + "/reviews-api".length), searchParams);
    },
    async post(request) {
      return request.name === "authoringCapabilities"
        ? { ok: true, result: { softwareMapEnabled: false } }
        : { ok: true };
    },
    subscribe: () => ({ dispose() {} }),
    currentTheme: () => theme,
    onDidChangeTheme: (listener) => listen(themeListeners, listener),
    currentDiffLayout() {
      try {
        return globalThis.localStorage?.getItem(diffLayoutKey) === "unified"
          ? "unified"
          : "split";
      } catch {
        return "split";
      }
    },
    async setDiffLayout(layout) {
      try {
        globalThis.localStorage?.setItem(diffLayoutKey, layout);
      } catch {}

      for (const listener of layoutListeners) listener(layout);
    },
    onDidChangeDiffLayout: (listener) => listen(layoutListeners, listener),
    ready() {},
  };
}
