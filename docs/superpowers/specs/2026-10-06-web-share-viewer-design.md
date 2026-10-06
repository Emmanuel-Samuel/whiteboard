# Web share viewer

Render a shared whiteboard in a browser, without the desktop app. The viewer
lives in a new private repo, `devdotfast/cloudboard`. This repo supplies the
canvas as a prebuilt bundle, a share-backed bridge, a browser code and diff
renderer, and share packages that carry source text.

Lands after the remote stack (#935 to #949). Read-only. No LSP, Ask, traces,
structural diff, or reader progress in v1.

## Why no UI rewrite

The canvas (`packages/review/app`) has no Electron, VS Code or LSP imports.
The browser tests already mount `mountReviewCanvas` in vanilla Chromium with
an in-memory bridge (`fixture-review-bridge.ts`). Everything the canvas draws
itself renders on the web today: markdown, KaTeX, code blocks, flow and
sequence diagrams, database lens, call tree, software map (given the libavoid
WASM URL), table of contents, lenses sidebar.

Host coupling is confined to `ReviewCanvasBridge`
(`packages/review-protocol/src/contracts.ts`):

- `request(url, init)`: every read goes through this one fetch-like function
  speaking the `/reviews-api` HTTP dialect.
- `inlineEditors: ReviewInlineEditorFactory`: code peeks. Desktop draws these
  with Monaco.
- `diffView: ReviewDiffViewFactory`: the Diff tab. Desktop draws it with
  Monaco's multi-diff.

So the work is: a bridge whose `request` answers from a share package, browser
implementations of the two factories, and share packages that contain the
source text those factories need.

## 1. Share format

Manifest format stays `review-share/1`. `shareManifestSchema` is strict and
the share server (`dev/apps/review-web`) parses it with the published
`@dev.fast/review-share-protocol`, so a manifest change would gate publishing
on a protocol release and a server redeploy. Objects are opaque to the server,
and the manifest already allows declared objects that only other objects
reference. New data therefore lives in objects.

### Presentation object gains `sources`

`sharePresentationSchema` (`packages/review/src/sharing/import.ts`) becomes:

```ts
{
  maps: Record<string, Map>,            // unchanged
  sources?: {
    diff: objectId,                     // JSON: ReviewDiffFileWire[] with patches,
                                        // exactly what GET /:id/diff returns
    commits: objectId,                  // JSON: exactly what GET /:id/commits returns
    files: {
      path: sharePath,
      commit: sha,                      // resolves side -> commit via pins
      object: objectId,                 // UTF-8 text
    }[],
  },
}
```

Each file text is its own content-addressed object, so identical text at base
and head, or across anchors with their own pins, dedupes for free and the
32 MiB per-object limit applies per file. Keyed by commit, not side, because
anchors may carry their own pins (`ReviewSourcePins`).

### What export embeds

`exportShare` (`packages/review/src/sharing/export.ts`), when the review has
pins:

1. `diff`: `data.changes(pins)` for the file list and `data.changes(pins, file)`
   for each patch.
2. `commits`: `data.commits(...)` as the route returns it.
3. `files`: text at both pins for every non-binary changed file (skip the
   missing side of added and deleted files), plus the file for every source
   anchor at `anchorPins(anchor, pins)`. Anchors are the same set
   `validateSource` already walks. Read with `readFileAtCommit`.

Files over `MAX_SHARE_OBJECT_BYTES` and binaries are skipped. Export logs the
skip. The viewer shows "not included in this share" for a peek or diff whose
text is missing.

Shares with no code references embed nothing new. `repository.cloneUrl` and
`pins` stay, so desktop import keeps cloning and nothing on the desktop changes
except accepting the new key.

### Compatibility

- Desktop import: `sharePresentationSchema` accepts `sources` and ignores it.
  Desktops older than this release reject new shares with a strict-schema
  error. Acceptable: the app auto-updates and share recipients run current
  builds.
- Share server: no change.
- Protocol package: no change. (If the manifest must change later, add a
  `sources` object id and bump to `review-share/2` then.)

### Copy and docs

Code now travels in the package. Update `docs/privacy.md` "Sharing" and the
share popover and CLI warning (`sharing/cli.ts`, `share-control.tsx`): the
copy includes the changed files and referenced source at the pinned commits,
and anyone with the link can read them.

## 2. Web build and share bridge (this repo)

### Build

`packages/review/app/web.vite.config.ts`, sharing the plugin list with the
desktop config except:

- no `scope-review-canvas-css` plugin (`@scope` is Chromium-only in practice;
  the unscoped `.review-canvas-root` rules still apply);
- no libavoid Trusted Types patch;
- StyleX Lightning CSS targets widened to current Safari and Firefox;
- entry `src/web-entry.tsx`, output `dist/web`, with a manifest.

### Published surface

`@dev.fast/whiteboard` gains a `./canvas` export pointing at the web build:
one ES module, one stylesheet, the libavoid WASM, and types. `files` already
includes `dist`. Cloudboard pins an exact version, as `dev` does for the other
`@dev.fast/*` packages. Bundling React inside is intentional: the canvas is an
island mounted into a div, independent of the host page's React.

### `web-entry.tsx`

```ts
export function mountSharedReview(
  container: HTMLElement,
  bundle: ShareBundle,                 // manifest + objects + attribution
  options: { theme: "dark" | "light"; wasmUrl: string;
             onThemeChange?: (listener) => Disposable },
): ReviewCanvasHandle
```

Builds a `ReviewCanvasBridge` and calls the existing `mountReviewCanvas` with
`{ kind: "api", reviewId, version, bridge,
   available: { sourceWindows: false, languageFeatures: false } }`.

`request` answers these routes from the bundle, 404 otherwise:

| Route | Source |
|---|---|
| `GET /:id?full=true` | snapshot object, with `shared: { login, sharedAt, cloneUrl }` added as `shared.get` does |
| `GET /watch?subscriptions=` | one `ReviewStreamLine` `{kind:"review", reviewId, value}`, stream stays open |
| `GET /:id/progress` | `{ files: [], lenses: [], resolvedSelections: {} }` |
| `GET /:id/diff` | `sources.diff`; `?file=` returns that entry's patch |
| `GET /:id/file?file&side[&commit\|anchor pins]` | `sources.files` text, side resolved to a commit via the review pins or the anchor's own pins (`readQuerySchemas.file`) |
| `GET /:id/commits` | `sources.commits` |
| `GET /:id/maps/:name` | presentation maps |
| `GET /:id/resources/:name` | resource objects with their MIME type |
| `GET /:id/stack` | 404 |
| `/:id/telemetry/*` | 204 |
| `POST /:id/progress`, `/commands`, `/copy-context`, `/ask/*` | 404 |

`post`: `authoringCapabilities` answers none; other verbs resolve with no
effect. `subscribe`: no events. Theme from `options`. Diff layout in
`localStorage`. `config.host` is `"web"`.

### Canvas changes that ride along

- `ReviewRuntimeConfig.host`: `z.enum(["desktop", "web"])`.
- `use-review-tab-telemetry.ts` calls `window.fetch` and `sendBeacon`
  directly, bypassing the bridge. Route it through `bridge.request` so the
  transport boundary test holds and the web bridge can drop it.
- Confirm during implementation which `available`/`host` flags exist after
  the remote stack merges, and that `host` is not needed (it relabels the
  metadata line).

## 3. Browser code and diff renderer (this repo)

`packages/review/app/src/web/`, built on `@pierre/diffs` (1.4 line at time of
writing; pin the latest stable at implementation). Shiki-based, worker pool for
highlighting, light and dark themes, shadow DOM rendering. Fonts and colors set
through its CSS variables (`--diffs-font-family` to Geist Mono) so it matches
the rest of the canvas.

### Diff tab: `ReviewDiffViewFactory`

- `files(scope)`: the embedded diff list.
- `create(spec)`: a `CodeView` over the changed files, mounted into
  `spec.container`. Each entry is built with `parseDiffFromFile(base, head)`
  from the embedded texts, which enables expanding unchanged context; falls
  back to `parsePatchFiles(patch)` when a side is missing. `diffStyle` follows
  the canvas diff layout. Our own small file tree in `spec.fileTreeContainer`.
- `revealFile`, `revealSource`, `sourceOffset`, `onDidScroll` map onto the
  view's `scrollTo` and item metrics. `setProgress` is accepted and ignored in
  v1 (the lens sidebar around the container renders counts).
- `scope` (per-commit diffs) returns the full diff in v1; commit scoping needs
  per-commit patches the share does not carry.

### Code peeks: `ReviewInlineEditorFactory`

`@pierre/diffs`' `File` component cannot render a line range or offset line
numbers, so peeks use a small line renderer of our own: tokenize the embedded
text with `getSharedHighlighter`, render only `spec.ranges` with real line
numbers, and report `height` plus `onDidChangeHeight`. `heightMode: "capped"`
is a fixed-height scroll container; `"content"` is unbounded. `setActive`
toggles a class. `find` and `setFindQuery` search the sliced text and return
counts; `revealFindMatch` scrolls within the peek. Hover and reveal stubs.

Missing text (skipped at export) renders a one-line notice in the container.

## 4. Cloudboard (new private repo, devdotfast org)

Mirror `dev/apps/review-web`: pnpm 11, Node 24, oxlint and oxfmt, TanStack
Start on a Cloudflare Worker via `@cloudflare/vite-plugin`, `wrangler.jsonc`
with a top-level dev env and `prod` on a custom domain, `deploy:prod` guarded
by `require-explicit-cloudflare-env`, CI that lints and format-checks.

- Route `/s/:shareId`: server renders a shell; the client reads the capability
  from `location.hash`, loads the bundle, mounts `mountSharedReview`. Theme
  toggle persisted in `localStorage`.
- Worker proxies the share API at app.dev.fast, forwarding
  `x-review-share-token`. Proxying avoids CORS changes on review-web and the
  S3 bucket, and lets the Worker reshape the fetch pattern, which is where the
  latency is today (per object: a D1 lookup, a presign round trip, then an S3
  fetch, four at a time). Objects never move to D1 or KV: D1 rows cap at 2 MB
  and KV values at 25 MiB, below the 32 MiB per-object limit.
  - `GET /api/view/:id`: manifest, sender, sharedAt.
  - `GET /api/view/:id/pack`: one file holding the manifest and every object
    the document needs to render (snapshot, presentation, diff, commits,
    source texts), as a JSON index followed by concatenated bytes. Built on
    first view from the share API, stored in the Cache API with a one-year
    immutable TTL, keyed by share id and manifest digest. Images and traces
    stay out of the pack.
  - `GET /api/view/:id/objects/:oid`: a single object (images, traces),
    streamed and cached immutable, since ids are digests.
- Client fetches the pack, then media lazily. It verifies each object's
  SHA-256 with WebCrypto and size against the manifest, then parses the
  snapshot and presentation with the schemas exported from
  `@dev.fast/whiteboard/sharing`.
- Development mode also loads a bundle from a local directory (manifest plus
  object files), so the viewer runs without the share service.
- No login in v1. The capability is the authorization, as for the desktop
  recipient routes.
- `dev/apps/review-web` `share-landing.tsx` gains a "View in browser" link to
  cloudboard alongside the desktop deep link.

## 5. Testing

This repo:

- `export.test.ts`: embeds diff, commits and files; dedupes identical text;
  skips binaries and oversize files; omits `sources` without pins.
- `import.test.ts`: accepts and ignores `sources`.
- `web-bridge.test.ts`: each route against a fixture bundle, including the
  watch line shape.
- Browser tests: `mountSharedReview` with the three saved reviews in
  `fixtures/saved-reviews`, extended with embedded sources; screenshots of a
  peek, the Diff tab in both layouts, and a software map.
- Renderer unit tests: range slicing and line numbering, find counts, missing
  text notice.

Cloudboard: unit tests for the proxy, the pack builder and the integrity
check. One end-to-end test: export a bundle from a fixture review with
`exportShare`, serve it through a stub of the two share API routes, load it
through the Worker's pack and object routes, and assert in Playwright that the
document, a code peek and the Diff tab render. Publishing to app.dev.fast
itself is a manual check with `whiteboard share`.

## MVP

The first cut proves the renderer and the export-to-render pipeline:

- This repo: `sources` in export; web build; `mountSharedReview`; renderer.
  Built off `main`; the bridge's `/watch` line is adapted when rebased onto the
  remote stack.
- Cloudboard: the `/s/:id` route, the proxy with pack, and local-bundle dev
  mode. Consumes the canvas from the sibling checkout via a `file:` dependency
  until `@dev.fast/whiteboard` publishes the `./canvas` export.
- The end-to-end test above, run in CI of both repos.

## 6. Sequencing

1. This repo: share format (section 1). Mergeable on its own; desktop
   unaffected.
2. This repo: web build, `./canvas` export, bridge (section 2). After the
   remote stack, since the bridge targets the new `/watch` contract.
3. This repo: renderer (section 3). Publish `@dev.fast/whiteboard`.
4. Cloudboard repo, then the review-web landing link.

## Follow-ups, not in v1

- Structural diff: embed diffr NDJSON at export, render rows on the web.
- Reader progress: `viewed-coverage` in the browser, persisted per share in
  `localStorage`.
- Per-commit diff scope, traces, Ask, server-side rendering.
