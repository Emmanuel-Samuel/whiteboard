# Web Share Viewer MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a shared whiteboard in a plain browser: export embeds source text, the canvas ships as a web bundle with a share-backed bridge and a browser code/diff renderer, and a new `cloudboard` app serves it.

**Architecture:** The canvas's host coupling is confined to `ReviewCanvasBridge` (`request`, `inlineEditors`, `diffView`). We add a bridge whose `request` answers from a share bundle, implement the two factories with `@pierre/diffs`, and build a web entry that composes them. Share packages gain a `sources` section (diff summaries, commits, file texts) inside the presentation object, so the manifest and the share server are untouched. Cloudboard is a thin Cloudflare Worker that proxies the share API, packs small objects into one response, and mounts the canvas.

**Tech Stack:** TypeScript, React 19, Vite 8, StyleX, zod 4, vitest 4 (node + Playwright browser projects), `@pierre/diffs` (Shiki-based diff renderer), TanStack Start + `@cloudflare/vite-plugin` + wrangler for cloudboard, pnpm 11, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-06-web-share-viewer-design.md`

## Global Constraints

- Whiteboard work happens in a sibling worktree `../whiteboard-web-viewer` on branch `web-share-viewer` off `origin/main`, never in the core checkout.
- Cloudboard is a new private repo in the devdotfast org at `/Users/aiansiti/workable/cloudboard`.
- No Claude attribution in commits or PR descriptions.
- Manifest format stays `review-share/1`; `shareManifestSchema` in `packages/review-share-protocol` is not changed.
- Per-object limit `MAX_SHARE_OBJECT_BYTES` (32 MiB) and share limit `MAX_SHARE_BYTES` (128 MiB) stay; oversize and binary files are skipped, not errors.
- Browser code under `packages/review/app/src/web/` and `packages/review/src/sharing/schemas.ts` must not import Node modules (`node:*`, `@dev.fast/local-vcs`, `./repository.js`, `./import.js`).
- `packages/review/app/src/host/review-transport-boundary.test.ts` must keep passing: only `host/review-client.ts` may call `fetch`/`EventSource` directly.
- Prefer no code comments; keep necessary ones terse. No change-detector tests.
- pnpm for JS; `pnpm install` once per worktree. Run `pnpm lint && pnpm format:check` before each commit.
- Pin `@pierre/diffs` to the latest stable 1.4.x (check `pnpm view @pierre/diffs version`). `minimumReleaseAge` is 7 days; if the newest is younger, pin the newest older one.

## Review Focus

1. A share whose review has no pins (pure markdown): export must omit `sources` entirely and the viewer must render without a Diff tab error. Test in Task 1 and Task 3.
2. A code peek whose file text was skipped at export (binary or oversize): the peek shows "Not included in this share" instead of throwing. Test in Task 4.
3. An anchor with its own `pins` (different `head` than the review): export embeds the file at that commit, and the peek reads it by commit, not by side. Test in Task 1 and Task 4.
4. A watch stream the canvas opens on mount: the bridge must answer `/watch` with one `Result[]` line and keep the body open, otherwise the canvas shows "Connection lost". Test in Task 2.
5. Cloudboard pack integrity: an object whose bytes don't match its digest must fail the whole load with a visible error, never render partial content. Test in Task 9.

---

## Setup

- [ ] **Step 0.1: Create the whiteboard worktree**

```bash
cd /Users/aiansiti/workable/whiteboard
git fetch origin main
git worktree add -b web-share-viewer ../whiteboard-web-viewer origin/main
cd ../whiteboard-web-viewer && pnpm install
cp -R ../whiteboard/packages/review/tutorial/.bundle packages/review/tutorial/ 2>/dev/null || true
pnpm --filter @dev.fast/whiteboard ensure:tutorial-assets
pnpm --filter @dev.fast/whiteboard build:workspace-deps
```

- [ ] **Step 0.2: Copy the spec and this plan into the worktree and commit**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp ../whiteboard/docs/superpowers/specs/2026-10-06-web-share-viewer-design.md docs/superpowers/specs/
cp ../whiteboard/docs/superpowers/plans/2026-10-06-web-share-viewer-mvp.md docs/superpowers/plans/
git add docs && git commit -m "Add the web share viewer spec and plan"
```

---

### Task 1: Export embeds diff summaries, commits and file texts

**Files:**
- Create: `packages/review/src/sharing/schemas.ts` (browser-safe schemas moved out of `import.ts`)
- Modify: `packages/review/src/sharing/import.ts` (import schemas from `./schemas.js`; delete the moved definitions)
- Modify: `packages/review/src/sharing/export.ts`
- Modify: `packages/review/src/sharing/index.ts` (export the schemas and `SharedSnapshot`, `SharePresentation`, `ShareSources` types)
- Test: `packages/review/src/sharing/export.test.ts` (existing; add cases)

**Interfaces:**
- Produces `ShareExportData = Pick<LocalReviewData, "map" | "validateResource" | "validateSource" | "changes" | "commits" | "file">`.
- Produces in `schemas.ts`:

```ts
export const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const shareSourcesSchema = z.strictObject({
  diff: objectIdSchema,
  commits: objectIdSchema,
  files: z.array(
    z.strictObject({ path: sharePathSchema, commit: commitSchema, object: objectIdSchema }),
  ),
});
export const sharePresentationSchema = z.strictObject({
  maps: z.record(z.string(), mapSchema),
  sources: shareSourcesSchema.optional(),
});
export const sharedSnapshotSchema = /* moved verbatim from import.ts */;
export type SharedSnapshot = z.infer<typeof sharedSnapshotSchema>;
export type SharePresentation = z.infer<typeof sharePresentationSchema>;
export type ShareSources = z.infer<typeof shareSourcesSchema>;
```

- `sources.diff` object: JSON `LocalVcsDiffFileSummary[]` exactly as `data.changes(pins)` returns (no patches).
- `sources.commits` object: JSON exactly as `data.commits(pins)` returns.

- [ ] **Step 1.1: Move the schemas**

Create `schemas.ts` with `sharedSnapshotSchema`, `mapSchema`, `count`, `counts`, `sharePresentationSchema` cut from `import.ts` (lines ~63–124), plus the new `commitSchema` and `shareSourcesSchema`. It imports only `zod`, `@dev.fast/review-share-protocol` (`objectIdSchema`, `sharePathSchema`), `@review/review-api/document.js` (`documentSchema`, `pinsSchema`), `@review/review-api/diff-lenses.js` (`lensSchema`) and the software-map element schemas `import.ts` already uses. In `import.ts` replace the definitions with `import { sharePresentationSchema, sharedSnapshotSchema } from "./schemas.js"`. Run `pnpm --filter @dev.fast/whiteboard test -- src/sharing` and confirm it still passes.

- [ ] **Step 1.2: Write the failing export tests**

Open `export.test.ts`, find how it builds `store` and `data` fakes, and add a describe block. The fake `data` gains `changes`, `commits`, `file`:

```ts
const files: Record<string, string> = {
  "head:src/a.ts": "export const a = 1;\nexport const b = 2;\n",
  "base:src/a.ts": "export const a = 1;\n",
  "head:src/new.ts": "new\n",
  "other:lib/x.ts": "x at other\n",
};
const data = {
  ...existingFakeData,
  async changes(pins: Pins) {
    return [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
      { path: "src/new.ts", status: "added", additions: 1, deletions: 0 },
      { path: "img.png", status: "modified", additions: 0, deletions: 0, binary: true as const },
    ];
  },
  async commits() {
    return [{ commit: "c".repeat(40), parentCommit: "b".repeat(40), subject: "one" }];
  },
  async file(pins: Pins, side: "base" | "head", file: string) {
    const key = pins.head === "f".repeat(40) ? `other:${file}` : `${side}:${file}`;
    const text = files[key];
    if (text === undefined) throw new ReviewInputError("File is unavailable at the pinned commit.", 404);
    return text;
  },
};

it("embeds diff summaries, commits and file texts at both pins", async () => {
  const bundle = await exportShare({ store, data, reviewId, repository });
  const presentation = sharePresentationSchema.parse(json(bundle, bundle.manifest.presentation));
  const sources = presentation.sources!;
  expect(json(bundle, sources.diff)).toEqual(await data.changes(pins));
  expect(json(bundle, sources.commits)).toEqual(await data.commits());
  const byKey = Object.fromEntries(sources.files.map((f) => [`${f.commit}:${f.path}`, text(bundle, f.object)]));
  expect(byKey[`${pins.head}:src/a.ts`]).toBe(files["head:src/a.ts"]);
  expect(byKey[`${pins.base}:src/a.ts`]).toBe(files["base:src/a.ts"]);
  expect(byKey[`${pins.head}:src/new.ts`]).toBe("new\n");
  expect(byKey[`${pins.base}:src/new.ts`]).toBeUndefined();   // added: no base side
  expect(sources.files.some((f) => f.path === "img.png")).toBe(false); // binary skipped
  for (const f of sources.files) expect(bundle.manifest.objects.some((o) => o.id === f.object)).toBe(true);
});

it("embeds the file behind an anchor with its own pins", async () => {
  // document contains a code_peek whose source has pins { repositoryId, head: "f".repeat(40) } on lib/x.ts
  const bundle = await exportShare({ store: storeWithPinnedPeek, data, reviewId, repository });
  const sources = sharePresentationSchema.parse(json(bundle, bundle.manifest.presentation)).sources!;
  expect(sources.files).toContainEqual(expect.objectContaining({ path: "lib/x.ts", commit: "f".repeat(40) }));
});

it("dedupes identical text across commits", async () => {
  // base and head text identical for one file -> one object, two files entries
});

it("omits sources for a review without pins", async () => {
  const bundle = await exportShare({ store: markdownOnlyStore, data, reviewId });
  expect(sharePresentationSchema.parse(json(bundle, bundle.manifest.presentation)).sources).toBeUndefined();
});

it("skips a file over the object limit", async () => {
  // data.file returns "x".repeat(MAX_SHARE_OBJECT_BYTES + 1) for one path; expect it absent from files, export succeeds
});
```

`json(bundle, id)` and `text(bundle, id)` are tiny helpers: `JSON.parse(Buffer.from(bundle.objects.get(id)!).toString())` and the string form.

- [ ] **Step 1.3: Run the tests to verify they fail**

Run: `pnpm --filter @dev.fast/whiteboard test -- src/sharing/export.test.ts`
Expected: FAIL (`sources` undefined, `changes` not in type).

- [ ] **Step 1.4: Implement in `export.ts`**

After the `validateSource` loop and before `const snapshotId = json(snapshot)`:

```ts
let sourcesIndex: ShareSources | undefined;

if (pins) {
  const summaries = await input.data.changes(pins);
  const wanted = new Map<string, { path: string; commit: string }>();
  const want = (path: string, commit: string) => wanted.set(`${commit}\0${path}`, { path, commit });

  for (const summary of summaries) {
    if (summary.binary) continue;
    if (summary.status !== "added") want(summary.previousPath ?? summary.path, pins.base);
    if (summary.status !== "deleted") want(summary.path, pins.head);
  }

  for (const reference of sources) {
    const at = anchorPins(reference.source, pins);
    want(reference.source.file, at[reference.source.side ?? "head"]);
  }

  const files: ShareSources["files"] = [];

  for (const { path, commit } of wanted.values()) {
    const text = await readText(path, commit);
    if (text === undefined) continue;
    const bytes = Buffer.from(text);
    if (bytes.byteLength > MAX_SHARE_OBJECT_BYTES) continue;
    files.push({ path, commit, object: add(bytes) });
  }

  sourcesIndex = {
    diff: json(summaries),
    commits: json(await input.data.commits(pins)),
    files,
  };
}
```

`readText(path, commit)` calls `input.data.file({ ...pins, head: commit, base: commit }, "head", path)` and returns `undefined` when it throws a `ReviewInputError` with status 404 (missing side) or when the text is not valid UTF-8 (`data.file` already returns a string; a thrown "binary" error also maps to `undefined`). Then `const presentationId = json({ maps, ...(sourcesIndex && { sources: sourcesIndex }) })`. Widen `ShareExportData` to include `"changes" | "commits" | "file"`. The callers of `exportShare` pass a full `LocalReviewData`, so no call site changes.

- [ ] **Step 1.5: Run the tests to verify they pass, then the whole sharing suite**

Run: `pnpm --filter @dev.fast/whiteboard test -- src/sharing`
Expected: PASS, including `import.test.ts`, which proves the desktop import accepts a presentation with `sources`.

- [ ] **Step 1.6: Update the privacy copy**

In `docs/privacy.md` "Sharing", replace the two sentences about source code with: "It includes the changed files and the source each code reference points at, as text at the pinned commits. Anyone with the link can read them." In `packages/review/src/sharing/cli.ts` (line ~46) and `packages/review/app/src/share-control.tsx` (popover text), change the warning from "require GitHub repository access to fetch the pinned commits" to "include the changed files and referenced source at the pinned commits". Keep `repository.cloneUrl` in the manifest.

- [ ] **Step 1.7: Lint, format, commit**

```bash
pnpm lint && pnpm format:check && pnpm --filter @dev.fast/whiteboard typecheck
git add -A && git commit -m "Embed diff summaries, commits and file texts in share packages"
```

---

### Task 2: Browser-safe share reader and the share bridge

**Files:**
- Create: `packages/review/src/sharing/read.ts` (browser-safe; reads a verified bundle into a `SharedReview`)
- Create: `packages/review/app/src/web/share-bridge.ts`
- Modify: `packages/review-protocol/src/contracts.ts:106` (`host: z.enum(["desktop", "web"])`)
- Modify: `packages/review/app/src/use-review-tab-telemetry.ts` (route `window.fetch`/`sendBeacon` through `session.bridge.request`; drop `sendBeacon`)
- Modify: `packages/review/src/sharing/index.ts` (export `readSharedReview`, `SharedReview`)
- Test: `packages/review/src/sharing/read.test.ts`, `packages/review/app/src/web/share-bridge.test.ts` (canvas-node project)

**Interfaces:**

```ts
// read.ts
export interface SharedReview {
  manifest: ShareManifest;
  snapshot: SharedSnapshot;
  presentation: SharePresentation;
  attribution?: { login: string; sharedAt: number };
  object(id: string): Uint8Array;            // throws if undeclared or missing
  json(id: string): JsonValue;
  diff(): LocalVcsDiffFileSummary[];         // [] when no sources
  commits(): JsonValue;                      // [] when no sources
  text(path: string, commit: string): string | undefined;
}
/** Bytes are already digest-verified by the caller (import.ts or the cloudboard client). */
export function readSharedReview(bundle: ShareBundle): SharedReview;
```

```ts
// share-bridge.ts
export interface ShareBridgeOptions {
  wasmUrl: string;
  theme: "dark" | "light";
  onDidChangeTheme?: (listener: (theme: "dark" | "light") => void) => { dispose(): void };
  inlineEditors: ReviewInlineEditorFactory;
  diffView: ReviewDiffViewFactory;
}
export function createShareBridge(review: SharedReview, options: ShareBridgeOptions): ReviewCanvasBridge;
/** The snapshot the bridge serves: adds `target` and `shared` like SharedReviewStore.get. */
export function servedSnapshot(review: SharedReview): Snapshot;
```

- [ ] **Step 2.1: Write the failing reader test**

`read.test.ts`: build a bundle by hand (manifest with two objects, `objects` Map) using `digestBytes` from `export.ts` for ids, with a presentation `{ maps: {}, sources: { diff, commits, files: [{ path: "a.ts", commit: "a".repeat(40), object }] } }`. Assert `readSharedReview(bundle).text("a.ts", "a".repeat(40))` is the text, `.text("a.ts", "b".repeat(40))` is `undefined`, `.diff()` equals the summaries, and a bundle without `sources` gives `diff()` `[]`. Assert `readSharedReview` throws when the manifest's `snapshot` object is missing from `objects`.

- [ ] **Step 2.2: Implement `read.ts`**

Parse `shareManifestSchema`, `sharedSnapshotSchema` (apply `migrateStoredDocument` + `liftSharedLenses` the same way `import.ts` does; move `liftSharedLenses` into `read.ts` and import it from there in `import.ts`), `sharePresentationSchema`. Build a `Map<string, string>` keyed `${commit}\0${path}` to object id lazily on first `text()` call. Decode with `new TextDecoder().decode(bytes)`. No `Buffer`, no `node:*`.

- [ ] **Step 2.3: Run the reader test**

Run: `pnpm --filter @dev.fast/whiteboard test -- src/sharing/read.test.ts`
Expected: PASS.

- [ ] **Step 2.4: Write the failing bridge test**

`share-bridge.test.ts` (node project; `Response` and streams exist in Node 24):

```ts
const bridge = createShareBridge(review, { wasmUrl: "http://127.0.0.1:1/libavoid.wasm", theme: "dark", inlineEditors: stubEditors, diffView: stubDiffView });
const base = `${bridge.config.serverUrl}/reviews-api`;
const id = review.snapshot.reviewId;

it("serves the snapshot with target and shared", async () => {
  const body = await (await bridge.request(`${base}/${id}?full=true&version=${review.snapshot.version}`)).json();
  expect(body.target).toEqual({ kind: "commits", ...review.snapshot.pins });
  expect(body.shared).toEqual({ login: "octocat", sharedAt: 1, cloneUrl: review.manifest.repository?.cloneUrl });
});

it("answers the watch stream with one Result[] line and stays open", async () => {
  const response = await bridge.request(`${base}/watch?subscriptions=${encodeURIComponent(JSON.stringify([{ reviewId: id }]))}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  const [result] = JSON.parse(value!.trim());
  expect(result.value.reviewId).toBe(id);
  expect(result.value.activity).toEqual({ workingCount: 0, expiresAt: null });
  const second = Promise.race([reader.read().then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 100))]);
  expect(await second).toBe("open");
});

it.each(["progress", "diff", "commits"])("answers %s", async (route) => {
  expect((await bridge.request(`${base}/${id}/${route}`)).status).toBe(200);
});

it("serves maps and resources from the bundle", ...); // 200 with the right content-type for an image resource
it("returns 204 for telemetry and 404 for everything else", ...); // `${base}/${id}/telemetry/event` -> 204; `${base}/${id}/ask/threads` -> 404
```

Also `bridge.post({ name: "authoringCapabilities", args: {} })` resolves `{ ok: true, result: { ... } }`: read what the desktop returns for this verb in `apps/review-desktop/code-oss/src/vs/review/**/reviewCanvasPart.ts` (search `authoringCapabilities`) and return the "nothing available" shape.

- [ ] **Step 2.5: Implement `share-bridge.ts`**

`config`: `{ serverUrl: "http://127.0.0.1:1", reviewId, token: "", wasmUrl, appVersion: "web", theme, host: "web" }`. `request(url)` parses `new URL(url)`, takes the path after `/reviews-api`, and matches in this order: `/watch` (any query) → `new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(JSON.stringify([{ value: { ...servedSnapshot(review), activity: { workingCount: 0, expiresAt: null } } }]) + "\n")); } }), { headers: { "content-type": "application/x-ndjson" } })` (never closes; `cancel` is a no-op); `/${id}` with `full=true` → `Response.json(servedSnapshot(review))`; `/${id}/progress` → `Response.json({ files: [], lenses: [], resolvedSelections: {} })`; `/${id}/diff` → `Response.json(review.diff())`; `/${id}/commits` → `Response.json(review.commits())`; `/${id}/maps/:name` → `Response.json(review.presentation.maps[name])` or 404; `/${id}/resources/:name` → find in `manifest.resources`, `new Response(new Blob([review.object(resource.object)]), { headers: { "content-type": resource.mimeType } })`; `/${id}/telemetry/` prefix → `new Response(null, { status: 204 })`; else `Response.json({ error: "Not available in a shared view." }, { status: 404 })`. `post`: `authoringCapabilities` as above; others `{ ok: true }`. `subscribe` returns a disposable no-op. `currentDiffLayout`/`setDiffLayout`/`onDidChangeDiffLayout` back a `localStorage` key `review-web:diff-layout` with a listener set. `ready() {}`. `servedSnapshot` mirrors `SharedReviewStore.get` in `import.ts:566–588` but keeps the original `reviewId`.

- [ ] **Step 2.6: Widen `host` and fix tab telemetry**

`contracts.ts`: `host: z.enum(["desktop", "web"])`. In `use-review-tab-telemetry.ts` replace the direct `window.fetch`/`navigator.sendBeacon` calls with `session.bridge.request(url, { method: "POST", body, keepalive: true })` and swallow errors. Run `pnpm --filter @dev.fast/review-canvas test:node -- review-transport-boundary` and the telemetry tests.

- [ ] **Step 2.7: Run bridge tests, typecheck, commit**

```bash
pnpm --filter @dev.fast/review-canvas test:node -- web/share-bridge
pnpm typecheck
pnpm lint && pnpm format:check
git add -A && git commit -m "Read share bundles in the browser and serve them through a canvas bridge"
```

---

### Task 3: Web entry, web Vite build, and the `./canvas` export

**Files:**
- Create: `packages/review/app/src/web-entry.tsx`
- Create: `packages/review/app/web.vite.config.ts`
- Create: `packages/review/app/src/web-entry.d.ts` (hand-written public types, copied to dist)
- Modify: `packages/review/app/package.json` (script `build:web`)
- Modify: `packages/review/package.json` (`exports["./canvas"]`, `exports["./canvas/*"]`, `build` runs the web build after tsdown)
- Modify: `packages/review/app/stylex-options.ts` (targets parameterized: desktop Chrome 140; web adds `safari: 17 << 16`, `firefox: 128 << 16`)
- Test: `packages/review/app/src/web-entry.browser.test.tsx`

**Interfaces:**

```ts
export interface MountSharedReviewOptions {
  wasmUrl: string;
  theme: "dark" | "light";
  onDidChangeTheme?: (listener: (theme: "dark" | "light") => void) => { dispose(): void };
}
export function mountSharedReview(container: HTMLElement, bundle: ShareBundle, options: MountSharedReviewOptions): ReviewCanvasHandle;
export { readSharedReview } from "@review/sharing/read";
export type { ShareBundle, SharedReview } from "@review/sharing/...";
```

For this task `inlineEditors`/`diffView` are the placeholders from `fixture-review-bridge.ts` moved into `web/placeholders.ts`; Tasks 4 and 5 replace them.

- [ ] **Step 3.1: Write the failing browser test**

`web-entry.browser.test.tsx`: build a `ShareBundle` in the browser with a helper `testShareBundle({ snapshot, presentation, resources })` (new file `web/test-share-bundle.ts`) that JSON-encodes each part and digests with `crypto.subtle.digest("SHA-256", bytes)`. Use the `three-minute-tour` saved review as `snapshot.document` (same setup as `real-reviews.browser.test.tsx`), pins `{ repositoryId: "repo", base: "a".repeat(40), head: "b".repeat(40) }`, `repository: { cloneUrl: "https://github.com/devdotfast/whiteboard.git" }`, `attribution: { login: "octocat", sharedAt: 1 }`. Mount with `mountSharedReview(container, bundle, { wasmUrl: libavoidWasmUrl, theme: "dark" })`. Assert the title phrase renders, `[data-block-error]` is absent, the text does not contain "Connection lost", and "Shared by octocat" appears. Second test: a markdown-only snapshot without pins renders and has no "Diff" tab error.

- [ ] **Step 3.2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review-canvas test:browser -- web-entry`
Expected: FAIL (module not found).

- [ ] **Step 3.3: Implement `web-entry.tsx`**

```tsx
import "./styles.css";
export function mountSharedReview(container, bundle, options) {
  const review = readSharedReview(bundle);
  const bridge = createShareBridge(review, { ...options, inlineEditors: placeholderInlineEditors(), diffView: placeholderDiffView() });
  return mountReviewCanvas(container, { kind: "api", reviewId: review.snapshot.reviewId, version: review.snapshot.version, bridge });
}
```

`mountReviewCanvas` is imported from `./desktop-entry`; it is host-agnostic despite the name (the `.monaco-workbench` lookup only runs for non-api content).

- [ ] **Step 3.4: Web Vite config and package wiring**

`web.vite.config.ts`: same as `desktop.vite.config.ts` minus the `scope-review-canvas-css` and `harden-libavoid-trusted-types` plugins, `stylex.vite(webStylexOptions)`, input `canvas: src/web-entry.tsx`, `outDir: "../dist/canvas"`, `emptyOutDir: true`, `manifest: true`, `base: "./"`, `build.lib` not used (keep `rollupOptions.preserveEntrySignatures: "strict"`), and `entryFileNames: "canvas.js"`, `assetFileNames: "assets/[name]-[hash][extname]"`. Copy `node_modules/@mr_mint/elkjs-libavoid/dist/libavoid.wasm` to `../dist/canvas/libavoid.wasm` and `src/web-entry.d.ts` to `../dist/canvas/canvas.d.ts` in a `closeBundle` hook. `packages/review/app/package.json`: `"build:web": "vite build --config web.vite.config.ts"`. `packages/review/package.json`: `"build": "node --max-old-space-size=8192 node_modules/tsdown/dist/run.mjs && pnpm --filter @dev.fast/review-canvas build:web"` and

```json
"./canvas": { "types": "./dist/canvas/canvas.d.ts", "import": "./dist/canvas/canvas.js" },
"./canvas/*": "./dist/canvas/*"
```

Run `pnpm --filter @dev.fast/whiteboard build` and check `packages/review/dist/canvas/` holds `canvas.js`, one `.css`, `libavoid.wasm`, fonts, `canvas.d.ts`.

- [ ] **Step 3.5: Run the browser test, lint, commit**

```bash
pnpm --filter @dev.fast/review-canvas test:browser -- web-entry
pnpm lint && pnpm format:check && pnpm typecheck
git add -A && git commit -m "Add a web entry and build for the shared review canvas"
```

---

### Task 4: Code peeks in the browser

**Files:**
- Create: `packages/review/app/src/web/inline-editors.tsx`
- Create: `packages/review/app/src/web/highlight.ts` (Shiki access via `@pierre/diffs`' `getSharedHighlighter`, language from file extension)
- Create: `packages/review/app/src/web/web-styles.ts` (StyleX for the peek: gutter, line, active/match classes; monospace via `tokens` from `tokens.stylex.ts`)
- Modify: `packages/review/app/package.json` (add `@pierre/diffs`)
- Test: `packages/review/app/src/web/inline-editors.browser.test.tsx`

**Interfaces:**

```ts
export function createWebInlineEditors(review: Pick<SharedReview, "text" | "snapshot">): ReviewInlineEditorFactory;
```

Resolution of a spec to text: `commit = spec.pins ? (spec.side === "base" ? spec.pins.base ?? spec.pins.head : spec.pins.head) : snapshot.pins![spec.side]`, then `review.text(spec.path, commit)`.

- [ ] **Step 4.1: Install `@pierre/diffs`**

`pnpm --filter @dev.fast/review-canvas add @pierre/diffs@<latest stable 1.4.x>`. Confirm `import { getSharedHighlighter } from "@pierre/diffs"` resolves and check its signature in `node_modules/@pierre/diffs/dist/*.d.ts` (theme names `pierre-dark`/`pierre-light`, `codeToTokens`/`codeToHast` style API). Record the exact call used in `highlight.ts`.

- [ ] **Step 4.2: Write the failing browser test**

```tsx
const review = { snapshot: { pins: { repositoryId: "r", base: B, head: H } }, text: (path, commit) => commit === H && path === "src/a.ts" ? "line1\nline2\nline3\nline4\nline5\n" : undefined };
const editors = createWebInlineEditors(review);

it("renders only the requested ranges with real line numbers", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const handle = editors.create({ container, path: "src/a.ts", title: "a", side: "head", ranges: [{ startLine: 2, endLine: 3 }], heightMode: "content", active: false });
  await settled(() => container.querySelector("[data-line='3']"));
  expect(container.textContent).toContain("line2"); expect(container.textContent).not.toContain("line1");
  expect(handle.height).toBeGreaterThan(0);
});
it("reports height changes once rendered", ...); // onDidChangeHeight fires with a positive number
it("finds matches inside the ranges", async () => { expect((await handle.setFindQuery({ text: "line", matchCase: false, wholeWord: false, isRegex: false })).matchCount).toBe(2); });
it("shows a notice when the text is not in the share", ...); // text() undefined -> container text includes "Not included in this share"
it("reads an anchor with its own pins by commit", ...); // spec.pins.head = OTHER, review.text(path, OTHER) returns text
it("find() without an editor counts matches", ...); // editors.find(spec, query)
```

- [ ] **Step 4.3: Run to verify failure, implement**

Implementation: `create` renders a React root into `spec.container` with a `<Peek>` component: for each range, a `<div data-range>` of `<div data-line={n}>` rows: gutter `<span>` with the number and a code `<span>` with highlighted HTML from `highlight.ts` (tokenize the whole file once per `(path, commit)` with a module-level cache, then slice lines). Capped mode: wrapper `max-height: 420px; overflow: auto`. Height: `ResizeObserver` on the wrapper updates `handle.height` and fires listeners. `setActive` toggles a class. Find: compute matches across the sliced lines (regex built from the query), wrap matches in `<mark>`, `revealFindMatch(i)` scrolls the i-th mark into view and marks it active; `clearActiveFindMatch`, `clearFind` clear state. `setCollapsed` toggles `display: none`. `dispose` unmounts. `find(spec, query)` resolves the text and counts without rendering. Language: map extension → Shiki language id in `highlight.ts`; unknown → plain text.

- [ ] **Step 4.4: Run tests, lint, commit**

```bash
pnpm --filter @dev.fast/review-canvas test:browser -- web/inline-editors
pnpm lint && pnpm format:check && pnpm typecheck
git add -A && git commit -m "Render code peeks in the browser"
```

---

### Task 5: The Diff tab in the browser

**Files:**
- Create: `packages/review/app/src/web/diff-view.tsx`
- Create: `packages/review/app/src/web/diff-worker.ts` (`import "@pierre/diffs/worker"` entry, if the package exposes a worker export; otherwise omit and highlight on the main thread)
- Test: `packages/review/app/src/web/diff-view.browser.test.tsx`

**Interfaces:**

```ts
export function createWebDiffView(review: Pick<SharedReview, "diff" | "text" | "snapshot">, layout: () => ReviewDiffLayout): ReviewDiffViewFactory;
```

- [ ] **Step 5.1: Write the failing browser test**

```tsx
const review = { snapshot: { pins }, diff: () => [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }], text: (p, c) => c === pins.base ? "a\n" : "a\nb\n" };
const view = createWebDiffView(review, () => "unified");
it("lists files", async () => { expect(await view.files()).toEqual([{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }]); });
it("renders the diff of each file from both texts", async () => {
  const container = document.createElement("div"); const tree = document.createElement("div"); document.body.append(container, tree);
  const handle = view.create({ container, fileTreeContainer: tree });
  await settled(() => container.textContent?.includes("b"));
  expect(tree.textContent).toContain("src/a.ts");
  handle.revealFile?.("src/a.ts"); // does not throw
});
it("reports an error through onDidError when a side is missing and no patch exists", ...); // text() undefined for both sides -> error listener called once with a message naming the file
```

- [ ] **Step 5.2: Implement**

`files()` returns `review.diff()` mapped to `ReviewDiffFileWire` (status `"renamed"` kept; no `patch`). `create(spec)`: React root in `spec.container` rendering `@pierre/diffs/react`'s `CodeView` (or `MultiFileDiff` if `CodeView` needs worker setup that is awkward) with one item per file built by `parseDiffFromFile({ name: previousPath ?? path, contents: baseText }, { name: path, contents: headText })` (`null` for the missing side of added/deleted files), `diffStyle: layout() === "split" ? "split" : "unified"`, `theme: { dark: "pierre-dark", light: "pierre-light" }`, `themeType` from `document.documentElement.dataset.reviewTheme` (set by `mountReviewCanvas`). Our file tree in `spec.fileTreeContainer`: a `<ul>` of paths with additions/deletions; clicking calls `revealFile`. `revealFile(path)` scrolls the file's element into view. `onDidScroll` wires a scroll listener on the container reporting `{ height: container.clientHeight }`. `sourceOffset(source)` returns the file element's `offsetTop - container.scrollTop` or `undefined`. `setProgress` stores and ignores. `onDidError` listener set; a file with no text on either side reports "src/a.ts is not included in this share." once. `dispose` unmounts.

- [ ] **Step 5.3: Run tests, lint, commit**

```bash
pnpm --filter @dev.fast/review-canvas test:browser -- web/diff-view
pnpm lint && pnpm format:check && pnpm typecheck
git add -A && git commit -m "Render the Diff tab in the browser"
```

---

### Task 6: Wire the renderers into the web entry and prove it on a real review

**Files:**
- Modify: `packages/review/app/src/web-entry.tsx` (use `createWebInlineEditors` and `createWebDiffView`; delete `web/placeholders.ts`)
- Create: `packages/review/scripts/write-share-fixture.ts` (writes a bundle directory for cloudboard's dev mode and e2e)
- Create: `packages/review/app/src/fixtures/shares/peek-and-diff.json` (a small review document: one markdown block, one `code_peek` on `src/a.ts` lines 2–3, one lens; with `sources` texts inline so the browser test can build the bundle)
- Test: `packages/review/app/src/web-entry.browser.test.tsx` (extend)

- [ ] **Step 6.1: Extend the browser test**

Mount the `peek-and-diff` review via `testShareBundle`. Assert: the peek container contains "line2"; clicking the "Diff" tab (find the tab by its accessible name in `App.tsx`) shows `src/a.ts` in the tree and the added line text in the view; switching the layout control to split re-renders without error. Screenshot both states to `.vitest-attachments` for the reviewer.

- [ ] **Step 6.2: Wire and run**

```bash
pnpm --filter @dev.fast/review-canvas test:browser
pnpm --filter @dev.fast/review-canvas test:node
```

Expected: all green, including `real-reviews.browser.test.tsx` (its fixture bridge is unchanged).

- [ ] **Step 6.3: Fixture writer script**

`write-share-fixture.ts`: `tsx packages/review/scripts/write-share-fixture.ts <outDir>`. Builds the same in-memory `store`/`data` fakes as `export.test.ts` (extract them into `packages/review/src/sharing/export-fixtures.ts` so both use one source), calls `exportShare`, and writes `<outDir>/manifest.json`, `<outDir>/share.json` (`{ sender: { login: "octocat" }, sharedAt: 1 }`) and `<outDir>/objects/<id>` for every object. Run it into `/tmp` once and confirm `manifest.json` parses with `shareManifestSchema`.

- [ ] **Step 6.4: Full checks, commit, build, note the dist path**

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm --filter @dev.fast/whiteboard build
git add -A && git commit -m "Mount shared reviews on the web with browser code peeks and diffs"
```

`packages/review/dist/canvas/` is what cloudboard consumes via `file:`.

---

### Task 7: Scaffold cloudboard

**Files (new repo `/Users/aiansiti/workable/cloudboard`):**
- `package.json`, `pnpm-workspace.yaml` (single package, `nodeLinker: hoisted`), `.nvmrc` (`24`), `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json` (copy from `dev`), `.gitignore`, `README.md`
- `wrangler.jsonc`, `vite.config.ts`, `src/worker.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/routes/s.$shareId.tsx`, `src/styles.css`, `src/env.d.ts`
- `scripts/require-explicit-cloudflare-env.mjs` (copy from `dev`)
- `.github/workflows/ci.yml` (lint, format, typecheck, test)

- [ ] **Step 7.1: Create the repo**

```bash
gh repo create devdotfast/cloudboard --private --description "Web viewer for shared whiteboards" --clone
cd /Users/aiansiti/workable/cloudboard
```

- [ ] **Step 7.2: Scaffold**

`package.json` mirrors `dev/apps/review-web/package.json`: name `cloudboard`, scripts `dev` (`vite dev`), `build`, `deploy` (blocked via the script), `deploy:prod` (`CLOUDFLARE_ENV=prod pnpm run build && wrangler deploy --env prod`), `lint`, `format`, `format:check`, `typecheck`, `test` (vitest), `test:e2e` (playwright). Dependencies: `@tanstack/react-router`, `@tanstack/react-start`, `react`, `react-dom`, `zod`, `@dev.fast/review-share-protocol` (exact 0.1.2), `@dev.fast/whiteboard` as `file:../whiteboard-web-viewer/packages/review` (MVP only; swap for a version pin when published). Dev: `@cloudflare/vite-plugin`, `wrangler`, `vite`, `vitest`, `@cloudflare/vitest-plugin`, `playwright`, `@playwright/test`, `typescript`, `oxlint`, `oxfmt`, `@types/react`, `@types/react-dom`, `@types/node`. Use the same versions as `dev/apps/review-web/package.json` where they appear there.

`wrangler.jsonc`: name `cloudboard`, `compatibility_date` same as review-web, `nodejs_compat`, `main: src/worker.ts`, `workers_dev: false`, `preview_urls: false`, top-level `vars: { SHARE_ORIGIN: "http://127.0.0.1:8787" }`, `env.prod` with `name: cloudboard-prod`, `vars: { SHARE_ORIGIN: "https://app.dev.fast", NODE_ENV: "production" }`, `routes: [{ pattern: "<placeholder domain, leave as cloudboard.dev.fast>", custom_domain: true }]`, observability logs on.

`src/worker.ts`: like review-web's, without auth/CSP nonces: route `/api/view/*` to `handleViewRequest(request, env)` (Task 8), everything else to `serverEntry.fetch`. Add `applySecurityHeaders` with `Content-Security-Policy` allowing `'self'` scripts and `data:`/`blob:` workers (Shiki) and `img-src 'self' blob:`.

`src/routes/__root.tsx`: as review-web's, title "Cloudboard". `index.tsx`: one sentence "Open a share link to view a whiteboard." `s.$shareId.tsx`: validates `shareIdSchema`, renders `<ShareViewer shareId=... />` (Task 9 fills it; for now a placeholder reading the fragment and printing the id).

- [ ] **Step 7.3: Verify dev server and CI commands**

```bash
pnpm install && pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
pnpm dev &  # open http://localhost:5175/s/<any uuid>#<43 chars> and see the placeholder
```

Commit on `main`: "Scaffold cloudboard".

---

### Task 8: Worker proxy with pack and cache

**Files:**
- Create: `src/lib/view-api.ts` (`handleViewRequest(request: Request, env: { SHARE_ORIGIN: string }, cache?: Cache): Promise<Response>`)
- Create: `src/lib/pack.ts` (`encodePack(entries: { id: string; bytes: Uint8Array }[]): Uint8Array`, `decodePack(bytes: ArrayBuffer): Map<string, Uint8Array>`)
- Create: `scripts/share-stub.mjs` (Node HTTP server serving `fixtures/shares/<id>/` on the two share API routes plus `/objects-bytes/<id>/<oid>` as the "signed URL")
- Create: `fixtures/shares/<uuid>/` written by `tsx ../whiteboard-web-viewer/packages/review/scripts/write-share-fixture.ts fixtures/shares/<uuid>`
- Test: `src/lib/pack.test.ts`, `src/lib/view-api.test.ts` (plain vitest with a fake `fetch` injected through `env.fetch`)

**Interfaces:**
- Pack format: 4-byte little-endian length of a UTF-8 JSON header, the header `{ manifest, sender, sharedAt, entries: [{ id, offset, size }] }`, then the concatenated bytes. Response `content-type: application/octet-stream`, `cache-control: public, max-age=31536000, immutable`.
- Which objects go in the pack: `manifest.snapshot`, `manifest.presentation`, and when the presentation parses with `sources`, `sources.diff`, `sources.commits`, every `sources.files[].object`. Resources (`manifest.resources[].object`) are excluded.

- [ ] **Step 8.1: Pack tests**

Round-trip: `decodePack(encodePack([...]))` returns the same ids and bytes; empty entries list works; a truncated buffer throws.

- [ ] **Step 8.2: View API tests**

With a fake upstream that answers `GET ${SHARE_ORIGIN}/api/shared/:id` (`{ manifest, sender, sharedAt }`) when the header `x-review-share-token` equals `CAP`, `GET .../objects/:oid` (`{ url, expiresAt }`), and the object URL (bytes):

- `GET /api/view/:id` without the header → 404; with `CAP` → the manifest JSON.
- `GET /api/view/:id/pack` → a pack whose entries are exactly the pack set above; second call with the same cache instance does not hit the upstream (count fake calls).
- `GET /api/view/:id/objects/:oid` → bytes with the immutable cache header; an oid not in the manifest → 404.
- Upstream object bytes whose size differs from the manifest → 502 and nothing cached.

- [ ] **Step 8.3: Implement**

`handleViewRequest` matches the three routes, forwards the header, uses `caches.default` keyed by `new Request(`${origin}/api/view/${id}/pack?m=${manifestSha}`)` where `manifestSha` is `sha256(JSON.stringify(manifest))` via WebCrypto, fetches objects four at a time, verifies sizes, builds the pack. Upstream failures map to the upstream status for the manifest route and to 502 otherwise. Wire into `worker.ts`.

- [ ] **Step 8.4: Stub server and fixture**

`scripts/share-stub.mjs`: `node scripts/share-stub.mjs <port> <fixturesDir>`; `GET /api/shared/:id` reads `manifest.json` + `share.json`, checks the header against `fixtures/shares/<id>/capability.txt` (written by hand: 43 chars), returns 404 otherwise; `GET /api/shared/:id/objects/:oid` returns `{ url: http://127.0.0.1:<port>/objects-bytes/<id>/<oid>, expiresAt }`; `GET /objects-bytes/:id/:oid` streams the file. Write the fixture with the whiteboard script and commit it.

- [ ] **Step 8.5: Run, lint, commit**

```bash
pnpm test && pnpm lint && pnpm format:check && pnpm typecheck
git add -A && git commit -m "Proxy the share API with a packed, cached object set"
```

---

### Task 9: Client: load, verify, mount

**Files:**
- Create: `src/components/share-viewer.tsx` (reads `location.hash`, loads, mounts `mountSharedReview`)
- Create: `src/lib/load-share.ts` (`loadShare(shareId, capability, fetchImpl = fetch): Promise<ShareBundle>`; fetches the pack, then each resource object; verifies `size` and SHA-256 of every object against the manifest with WebCrypto; throws `ShareIntegrityError`)
- Modify: `src/routes/s.$shareId.tsx`, `vite.config.ts` (serve `@dev.fast/whiteboard/canvas/*` assets; import the canvas CSS in the viewer component), `src/styles.css` (full-height container, theme toggle)
- Test: `src/lib/load-share.test.ts` (fake fetch: happy path builds a `ShareBundle` with all objects; a tampered object rejects with `ShareIntegrityError` and no bundle)

- [ ] **Step 9.1: Tests first, then implement `load-share.ts`**

- [ ] **Step 9.2: Implement `share-viewer.tsx`**

States: `reading-link` → `loading` → `ready` | `error`. Invalid or missing fragment shows "This link is incomplete. Ask the sender to copy it again." (same copy as review-web). On ready, `mountSharedReview(container, bundle, { wasmUrl: new URL("@dev.fast/whiteboard/canvas/libavoid.wasm", import.meta.url).href, theme, onDidChangeTheme })`; dispose on unmount. Theme: `prefers-color-scheme` initially, a toggle button persisted to `localStorage["cloudboard:theme"]`. The component is client-only: wrap in `useEffect`, render nothing on the server.

- [ ] **Step 9.3: Manual check against the stub**

```bash
node scripts/share-stub.mjs 8787 fixtures/shares &
pnpm dev
# open http://localhost:5175/s/<fixture uuid>#<capability from capability.txt>
```

Expect the document, a peek with real lines, and the Diff tab. Commit: "Load and render a shared whiteboard".

---

### Task 10: End-to-end test and CI

**Files:**
- Create: `playwright.config.ts`, `e2e/share.spec.ts`
- Modify: `.github/workflows/ci.yml` (add `pnpm test` and `pnpm test:e2e`; e2e job checks out `devdotfast/whiteboard` at the `web-share-viewer` branch into `../whiteboard-web-viewer`, installs and builds it, because of the `file:` dependency)
- Modify: `README.md` (how to run locally against the stub and against app.dev.fast with `SHARE_ORIGIN`)

- [ ] **Step 10.1: Playwright config**

`webServer`: two entries, the stub (`node scripts/share-stub.mjs 8787 fixtures/shares`, port 8787) and `pnpm dev` (port 5175, `SHARE_ORIGIN=http://127.0.0.1:8787`). Chromium only.

- [ ] **Step 10.2: The test**

```ts
test("renders a shared whiteboard from the share API", async ({ page }) => {
  await page.goto(`/s/${SHARE_ID}#${CAPABILITY}`);
  await expect(page.getByText("Shared by octocat")).toBeVisible();
  await expect(page.getByText("<markdown heading from the fixture>")).toBeVisible();
  await expect(page.locator("[data-line='2']")).toContainText("line2");  // the peek
  await page.getByRole("tab", { name: /diff/i }).click();
  await expect(page.getByText("src/a.ts")).toBeVisible();
  await expect(page.locator("text=b")).toBeVisible(); // added line in the diff
  await expect(page.locator("[data-block-error]")).toHaveCount(0);
});
test("rejects a wrong capability", async ({ page }) => {
  await page.goto(`/s/${SHARE_ID}#${"x".repeat(43)}`);
  await expect(page.getByText(/unavailable|not found/i)).toBeVisible();
});
```

- [ ] **Step 10.3: Run, commit, push**

```bash
pnpm test:e2e && pnpm lint && pnpm format:check && pnpm typecheck
git add -A && git commit -m "Test the share pipeline end to end" && git push -u origin main
```

Then in the whiteboard worktree: `git push -u origin web-share-viewer` and open a draft PR titled "Render shared whiteboards on the web" whose body summarizes Tasks 1–6 and links the spec.

---

## Self-review notes

- Spec §1 → Task 1; §2 → Tasks 2–3; §3 → Tasks 4–5; §4 → Tasks 7–9; §5 → tests in every task plus Task 10; §6 sequencing → task order. The share server and review-web are untouched, as the spec requires.
- The `/watch` answer targets main's `Result[]` line shape; the stack's `ReviewStreamLine` is a one-line change in `share-bridge.ts` at rebase time (noted in the spec's MVP section).
- `data.file` returns a string, so "not valid UTF-8" cannot be detected there; binaries are excluded by the `binary` summary flag, which is what git reports. An anchor on a binary file is impossible since `validateSource` would already fail.
