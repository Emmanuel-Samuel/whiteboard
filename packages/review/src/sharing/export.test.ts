import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type JsonObject, isJsonObject } from "@dev.fast/review-protocol";
import {
  MAX_SHARE_OBJECTS,
  MAX_SHARE_OBJECT_BYTES,
} from "@dev.fast/review-share-protocol";
import { rangeAnchor } from "@review/lens-selection";
import { ReviewInputError } from "@review/review-api/document.js";
import { createReviewApi } from "@review/review-api/http.js";
import { openLocalReviewStore } from "@review/review-api/local-data.js";
import { afterEach, expect, it, vi } from "vitest";

import { gitShareFixture } from "./export-fixtures.js";
import {
  type ShareBundle,
  type ShareExportData,
  digestBytes,
  exportShare,
} from "./export.js";
import { SharedReviewStore, validateShareBundle } from "./import.js";
import { fetchPinnedRepository } from "./repository.js";
import { sharePresentationSchema } from "./schemas.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();

  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const shared = await gitShareFixture(
    await mkdtemp(path.join(os.tmpdir(), "review-sharing-")),
    {
      title: "A shared review",
      branch: "feature/shared-head",
      base: {
        "main.ts": "export const answer = 1;\n",
        "old.ts": "export const moved = true;\n",
        "deleted.ts": "export const obsolete = true;\n",
      },
      head: {
        "main.ts": "export const answer = 2;\n",
        "new.ts": "export const added = true;\n",
        "deleted.ts": null,
      },
      moves: { "old.ts": "renamed.ts" },
    },
  );

  cleanup.push(shared.close);
  const { root, repo, local, reviewId, pins } = shared;

  const traceId = randomUUID();
  await local.data.upload({
    kind: "trace",
    id: traceId,
    repositoryId: pins.repositoryId,
    trace: {
      label: "Retained conversation",
      events: [
        { id: "one", role: "user", text: "Change the answer." },
        { id: "two", role: "assistant", text: "Changed it to two." },
      ],
    },
  });

  await shared.insert([
    {
      type: "code_peek",
      source: rangeAnchor({
        side: "head",
        file: "main.ts",
        fromLine: 1,
        toLine: 1,
      }),
    },
    {
      type: "code_peek",
      source: rangeAnchor({
        side: "head",
        file: "new.ts",
        fromLine: 1,
        toLine: 1,
      }),
    },
    {
      type: "trace_quote",
      traceId,
      eventId: "one",
      text: "Change the answer.",
    },
  ]);

  return { root, repo, local, reviewId };
}

const repository = { cloneUrl: "https://github.com/fixture/review.git" };

async function importFixture(
  prepare: (
    fixtureData: Awaited<ReturnType<typeof fixture>>,
    bundle: ShareBundle,
  ) => Promise<ShareBundle> | ShareBundle = (_, bundle) => bundle,
) {
  const fixtureData = await fixture();
  const { root, repo, local, reviewId } = fixtureData;

  const bundle = await prepare(
    fixtureData,
    await exportShare({ ...local, reviewId, repository }),
  );

  const recipient = openLocalReviewStore(path.join(root, "recipient.db"));
  cleanup.push(() => recipient.store.close());
  cleanup.push(() => recipient.data.close());

  const fetchRepository = vi.fn<typeof fetchPinnedRepository>(
    (
      target: string,
      _url: string,
      pins: Parameters<typeof fetchPinnedRepository>[2],
    ) => fetchPinnedRepository(target, repo, pins),
  );

  const imported = new SharedReviewStore(
    path.join(root, "shared"),
    fetchRepository,
  );

  imported.connect(recipient.store, recipient.data);
  await imported.load();
  const shareId = randomUUID();
  const id = await imported.import("https://app.dev.fast", shareId, bundle);

  const app = createReviewApi(
    recipient.store,
    recipient.data,
    undefined,
    imported,
  );

  return {
    ...fixtureData,
    bundle,
    imported,
    recipient,
    shareId,
    id,
    app,
    fetchRepository,
  };
}

/** Stand in for a bundle shared by an older Review: its sealed snapshot
 * carries `status` on every section. */
function withLegacySectionStatus(bundle: ShareBundle): ShareBundle {
  const snapshot = JSON.parse(
    Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
  );

  for (const block of snapshot.document)
    if (block.type === "section") block.status = "complete";
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const id = digestBytes(bytes);
  const objects = new Map(bundle.objects);
  objects.delete(bundle.manifest.snapshot);
  objects.set(id, bytes);

  return {
    ...bundle,
    objects,
    manifest: {
      ...bundle.manifest,
      snapshot: id,
      objects: bundle.manifest.objects.map((object) =>
        object.id === bundle.manifest.snapshot
          ? { id, sha256: id, size: bytes.byteLength }
          : object,
      ),
    },
  };
}

it("exports a review saved with the retired section status and imports a bundle that still carries it", async () => {
  const { imported, id, bundle } = await importFixture(
    async ({ root, local, reviewId }) => {
      const { version } = await local.store.execute({
        operation: {
          type: "edit",
          reviewId,
          edit: {
            type: "insert",
            content: { type: "section", title: "Notes", children: [] },
          },
        },
      });

      const db = new DatabaseSync(path.join(root, "review.db"));
      db.prepare(
        `UPDATE versions SET snapshot=json_set(snapshot,'$.document[3].status','in_progress') WHERE review_id=? AND version=?`,
      ).run(reviewId, version);
      db.close();

      const exported = await exportShare({ ...local, reviewId, repository });
      const { snapshot } = validateShareBundle(exported);
      expect(snapshot.document[3]).toMatchObject({ title: "Notes" });
      expect(snapshot.document[3]).not.toHaveProperty("status");

      return withLegacySectionStatus(exported);
    },
  );

  expect(
    JSON.parse(
      Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
    ).document[3],
  ).toMatchObject({ status: "complete" });
  const shared = imported.get(id).snapshot.document[3];
  expect(shared).toMatchObject({ type: "section", title: "Notes" });
  expect(shared).not.toHaveProperty("status");
});

/** Rewrite a bundle's sealed snapshot, as an older Review would have sealed it. */
function withSnapshot(
  bundle: ShareBundle,
  rewrite: (snapshot: JsonObject) => JsonObject,
): ShareBundle {
  const bytes = Buffer.from(
    JSON.stringify(
      rewrite(
        JSON.parse(
          Buffer.from(bundle.objects.get(bundle.manifest.snapshot)!).toString(),
        ),
      ),
    ),
  );

  const id = digestBytes(bytes);
  const objects = new Map(bundle.objects);
  objects.delete(bundle.manifest.snapshot);
  objects.set(id, bytes);

  return {
    ...bundle,
    objects,
    manifest: {
      ...bundle.manifest,
      snapshot: id,
      objects: bundle.manifest.objects.map((object) =>
        object.id === bundle.manifest.snapshot
          ? { id, sha256: id, size: bytes.byteLength }
          : object,
      ),
    },
  };
}

it("shares a review's lenses and reads a bundle that holds them as document blocks", async () => {
  const lens = {
    title: "Changed code",
    targets: [
      { kind: "files", patterns: ["main.ts"] },
      {
        kind: "ranges",
        sources: [
          rangeAnchor({
            side: "head",
            file: "new.ts",
            fromLine: 1,
            toLine: 1,
          }),
        ],
      },
    ],
  };

  const { imported, id } = await importFixture(async ({ local, reviewId }) => {
    const { targetId } = await local.store.execute({
      operation: {
        type: "lens_edit",
        reviewId,
        edit: { type: "insert", ...lens },
      },
    });

    const exported = await exportShare({ ...local, reviewId, repository });
    expect(validateShareBundle(exported).snapshot.lenses).toEqual([
      { id: targetId, ...lens },
    ]);

    // An older Review sealed lenses into the document.
    return withSnapshot(exported, ({ lenses, document, ...snapshot }) => ({
      ...snapshot,
      document: [
        ...(Array.isArray(document) ? document : []),
        ...(Array.isArray(lenses) ? lenses : []).map((item) =>
          isJsonObject(item) ? { type: "file_lens", ...item } : item,
        ),
      ],
    }));
  });

  const shared = imported.get(id).snapshot;
  expect(shared.lenses).toEqual([{ id: expect.any(String), ...lens }]);
  expect(JSON.stringify(shared.document)).not.toContain("file_lens");
});

it("fetches pinned source into an independent repository and retains complete traces offline", async () => {
  const { bundle, imported, id, repo, app, recipient } = await importFixture();
  expect(imported.get(id).snapshot.origin?.branch).toBe("feature/shared-head");
  await rename(repo, repo + "-hidden");
  expect(
    (await (await app.request(`/${id}/file?side=head&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 2;\n");
  expect(
    (await (await app.request(`/${id}/file?side=base&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 1;\n");
  expect((await app.request(`/${id}/file?side=base&file=new.ts`)).status).toBe(
    404,
  );
  const diffs = await (await app.request(`/${id}/diff`)).json();
  expect(diffs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "new.ts", status: "added" }),
      expect.objectContaining({ path: "deleted.ts", status: "deleted" }),
      expect.objectContaining({ path: "renamed.ts", status: "renamed" }),
    ]),
  );

  const resource = bundle.manifest.resources.find(
    (item) => item.kind === "trace",
  )!;

  const trace = await (
    await app.request(`/${id}/resources/${resource.id}`)
  ).json();

  expect(trace.events).toHaveLength(2);
  const persisted = validateShareBundle(await imported.read(id));
  expect(persisted.snapshot.pins!.repositoryId).not.toBe(
    imported.get(id).snapshot.pins!.repositoryId,
  );

  const restarted = new SharedReviewStore(imported.root, async () => {
    throw new Error("offline");
  });

  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list().map((entry) => entry.reviewId)).toEqual([id]);
  await restarted.prepare(id);
  expect(restarted.get(id).snapshot.title).toBe("A shared review");
});

it("uses normal source and workspace routes but rejects authoring mutations", async () => {
  const { app, id, imported, recipient, bundle } = await importFixture();
  expect((await app.request(`/${id}/tree?side=head&path=`)).status).toBe(200);
  expect((await app.request(`/${id}/tree?side=invalid`)).status).toBe(400);
  expect(
    (await app.request(`/${id}/file?side=head&file=main.ts&version=999`))
      .status,
  ).toBe(404);
  expect(
    (await app.request(`/${id}/activity/begin`, { method: "POST" })).status,
  ).toBe(409);
  expect(
    (await app.request(`/${id}/source-attachment?side=head&file=main.ts`))
      .status,
  ).toBe(404);

  const source = await app.request(`/${id}/file?side=head&file=main.ts`);

  expect(source.status).toBe(200);

  const language = await (
    await app.request(`/${id}/language-context?side=head`)
  ).json();

  expect(language.rootPath).toBeTruthy();
  expect(await stat(path.join(language.rootPath, "main.ts"))).toBeTruthy();
  expect((await app.request(`/${id}/resources/not-included`)).status).toBe(404);
  expect(
    (await app.request(`/resources/${bundle.manifest.resources[0]!.id}`))
      .status,
  ).toBe(404);

  const mutation = await app.request("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: { type: "rename", reviewId: id, title: "Changed" },
    }),
  });

  expect(mutation.status).toBe(409);
  expect(recipient.store.list()).toEqual([]);
  expect(imported.get(id).snapshot.title).toBe("A shared review");
});

it("rejects tampered bytes and keeps resource IDs isolated across shares", async () => {
  const { bundle, imported, id, app } = await importFixture();

  const other = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  expect(other).not.toBe(id);
  const corrupt = { ...bundle, objects: new Map(bundle.objects) };
  corrupt.objects.set(bundle.manifest.snapshot, Buffer.from("{}"));
  await expect(
    imported.import("https://app.dev.fast", randomUUID(), corrupt),
  ).rejects.toThrow("corrupt");
  expect(
    (
      await app.request(
        `/${other}/resources/${bundle.manifest.resources[0]!.id}`,
      )
    ).status,
  ).toBe(200);
});

it("isolates corrupt cached shares at restart", async () => {
  const { bundle, imported, id, recipient } = await importFixture();

  const other = await imported.import(
    "https://app.dev.fast",
    randomUUID(),
    bundle,
  );

  await writeFile(
    path.join(imported.root, id, bundle.manifest.snapshot),
    "corrupt",
  );
  const restarted = new SharedReviewStore(imported.root);
  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list().map((entry) => entry.reviewId)).toEqual([other]);
});

it("repairs a missing checkout and removes owned workspaces before reimport", async () => {
  const { imported, id, recipient, bundle, shareId, repo, fetchRepository } =
    await importFixture();

  const checkout = imported.repositoryRoot(id);

  const paths = recipient.data.workspaces
    .list(id)
    .map((workspace) => workspace.rootPath!);

  await rm(checkout, { recursive: true, force: true });
  expect(() => imported.get(id)).toThrow("Fetch the shared repository");
  await imported.prepare(id);
  expect(fetchRepository).toHaveBeenCalledTimes(2);
  const repositoryId = imported.get(id).snapshot.pins!.repositoryId;
  await imported.removeLocal(id);

  for (const target of [checkout, ...paths])
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => recipient.store.repositoryPath(repositoryId)).toThrow(
    "not registered",
  );
  expect(await stat(path.join(repo, ".git"))).toBeTruthy();
  expect(await imported.import("https://app.dev.fast", shareId, bundle)).toBe(
    id,
  );
});

it("retains failed imports for retry and deduplicates preparation", async () => {
  const { local, root, repo, reviewId } = await fixture();
  const bundle = await exportShare({ ...local, reviewId, repository });
  let available = false;

  const fetcher = vi.fn<typeof fetchPinnedRepository>(
    async (
      target: string,
      _url: string,
      pins: Parameters<typeof fetchPinnedRepository>[2],
    ) => {
      if (!available)
        throw new ReviewInputError(
          "Configure Git credentials, then retry.",
          409,
        );
      await fetchPinnedRepository(target, repo, pins);
    },
  );

  const imported = new SharedReviewStore(path.join(root, "retry"), fetcher);
  imported.connect(local.store, local.data);
  await imported.load();
  const shareId = randomUUID();
  await expect(
    imported.import("https://app.dev.fast", shareId, bundle),
  ).rejects.toThrow("Configure Git credentials");
  const { sharedReviewId } = await import("./import.js");
  const id = sharedReviewId("https://app.dev.fast", shareId);
  expect(imported.status(id).stage).toBe("error");
  expect(imported.list()).toEqual([]);
  available = true;
  await Promise.all([imported.prepare(id), imported.prepare(id)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(imported.get(id).snapshot.title).toBe("A shared review");
});

it("does not expose an interrupted import before validation finishes", async () => {
  const { imported, id, recipient } = await importFixture();
  const repositoryId = imported.get(id).snapshot.pins!.repositoryId;
  await writeFile(
    path.join(imported.root, id, "repository.json"),
    JSON.stringify({ repositoryId, ready: false }),
  );
  const restarted = new SharedReviewStore(imported.root);
  restarted.connect(recipient.store, recipient.data);
  await restarted.load();
  expect(restarted.list()).toEqual([]);
  await restarted.prepare(id);
  expect(restarted.get(id).snapshot.pins!.repositoryId).toBe(repositoryId);
});

it("keeps the published snapshot and code after author edits and branch movement", async () => {
  const { local, repo, reviewId, imported, id, app } = await importFixture();
  const before = imported.get(id).snapshot;
  await writeFile(path.join(repo, "main.ts"), "export const answer = 999;\n");
  execFileSync("git", ["commit", "-am", "Later branch change"], {
    cwd: repo,
    stdio: "pipe",
  });
  await local.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: { type: "markdown", markdown: "Later author edit" },
      },
    },
  });
  expect(imported.get(id).snapshot).toEqual(before);
  expect(
    (await (await app.request(`/${id}/file?side=head&file=main.ts`)).json())
      .text,
  ).toBe("export const answer = 2;\n");
});

it("requires a pinned review before sharing saved worktree changes", async () => {
  const { local, reviewId, repo } = await fixture();
  const snapshot = local.store.read(reviewId);
  await local.store.execute({
    operation: {
      type: "set_target",
      reviewId,
      target: {
        kind: "worktree",
        repositoryId: snapshot.pins!.repositoryId,
        base: snapshot.pins!.base,
      },
    },
  });
  await writeFile(path.join(repo, "main.ts"), "export const answer = 99;\n");
  await expect(exportShare({ ...local, reviewId, repository })).rejects.toThrow(
    "Pin this review to commits before sharing it.",
  );
  await local.store.execute({
    operation: {
      type: "set_target",
      reviewId,
      target: { kind: "commits", ...snapshot.pins },
    },
  });
  const bundle = await exportShare({ ...local, reviewId, repository });
  expect(validateShareBundle(bundle).snapshot.pins!.head).toBe(
    snapshot.pins!.head,
  );
});

it("counts a shared review's changed lines without a local review row", async () => {
  const { id, app } = await importFixture();
  const response = await app.request(`/${id}/progress`);
  expect(response.status).toBe(200);
  const progress = await response.json();
  expect(progress.complete).not.toBe(false);
  expect(progress.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "new.ts" }),
      expect.objectContaining({ path: "deleted.ts" }),
    ]),
  );
});

it("lists and streams shared diff counts with the same persistence as local reviews", async () => {
  const { app, id, imported, recipient, local, reviewId, root } =
    await importFixture();

  const readCatalog = async () => await (await app.request("/")).json();

  expect((await readCatalog())[0].diffStats).toBeNull();

  const response = await app.request(
    "/watch?subscriptions=" +
      encodeURIComponent(JSON.stringify([{ reviewId: null }])),
  );

  const reader = response.body!.getReader();

  const next = async () =>
    JSON.parse(new TextDecoder().decode((await reader.read()).value));

  try {
    expect((await next()).reviews[0].diffStats).toBeNull();
    expect((await app.request(`/${id}/progress`)).status).toBe(200);

    const pins = local.store.read(reviewId).pins!;
    await local.data.coverage(reviewId, pins);
    const expected = local.store.list()[0].diffStats;

    expect(expected).toMatchObject({ fileCount: 4 });
    expect((await next()).reviews[0].diffStats).toEqual(expected);
    expect((await readCatalog())[0].diffStats).toEqual(expected);

    await recipient.data.close();

    const reopened = openLocalReviewStore(path.join(root, "recipient.db"));
    cleanup.push(() => reopened.store.close());
    cleanup.push(() => reopened.data.close());
    const restored = new SharedReviewStore(imported.root);
    restored.connect(reopened.store, reopened.data);
    await restored.load();

    const restarted = createReviewApi(
      reopened.store,
      reopened.data,
      undefined,
      restored,
    );

    expect((await (await restarted.request("/")).json())[0].diffStats).toEqual(
      expected,
    );
  } finally {
    await reader.cancel();
  }
});

const text = (bundle: ShareBundle, id: string) =>
  Buffer.from(bundle.objects.get(id)!).toString();

const sharedSources = (bundle: ShareBundle) =>
  sharePresentationSchema.parse(
    JSON.parse(text(bundle, bundle.manifest.presentation)),
  ).sources;

function exportData(
  data: ShareExportData,
  overrides: Partial<ShareExportData> = {},
): ShareExportData {
  return {
    map: data.map.bind(data),
    validateResource: data.validateResource.bind(data),
    validateSource: data.validateSource.bind(data),
    changes: data.changes.bind(data),
    commits: data.commits.bind(data),
    file: data.file.bind(data),
    ...overrides,
  } as ShareExportData;
}

it("embeds diff summaries, commits and file texts at both pins", async () => {
  const { local, reviewId } = await fixture();
  const pins = local.store.read(reviewId).pins!;
  const bundle = await exportShare({ ...local, reviewId, repository });
  const sources = sharedSources(bundle)!;

  expect(JSON.parse(text(bundle, sources.diff))).toEqual(
    await local.data.changes(pins),
  );
  expect(JSON.parse(text(bundle, sources.commits))).toEqual(
    await local.data.commits(pins),
  );

  const byKey = Object.fromEntries(
    sources.files.map((file) => [
      `${file.commit}:${file.path}`,
      text(bundle, file.object),
    ]),
  );

  expect(byKey).toEqual({
    [`${pins.base}:main.ts`]: "export const answer = 1;\n",
    [`${pins.head}:main.ts`]: "export const answer = 2;\n",
    [`${pins.head}:new.ts`]: "export const added = true;\n",
    [`${pins.base}:old.ts`]: "export const moved = true;\n",
    [`${pins.head}:renamed.ts`]: "export const moved = true;\n",
    [`${pins.base}:deleted.ts`]: "export const obsolete = true;\n",
  });

  const objects = new Set(bundle.manifest.objects.map((object) => object.id));

  for (const file of sources.files) expect(objects.has(file.object)).toBe(true);

  const moved = sources.files.filter((file) =>
    ["old.ts", "renamed.ts"].includes(file.path),
  );

  expect(moved).toHaveLength(2);
  expect(moved[0]!.object).toBe(moved[1]!.object);
  expect(validateShareBundle(bundle).snapshot.pins).toEqual(pins);
});

it("embeds the file behind an anchor with its own pins", async () => {
  const { local, reviewId, repo } = await fixture();
  const pins = local.store.read(reviewId).pins!;
  await writeFile(path.join(repo, "later.ts"), "export const later = 1;\n");

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  git("add", "later.ts");
  git("commit", "-m", "later");
  const later = git("rev-parse", "HEAD");

  await local.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: {
        type: "insert",
        content: {
          type: "code_peek",
          source: rangeAnchor({
            side: "head",
            file: "later.ts",
            fromLine: 1,
            toLine: 1,
          }),
          pins: { repositoryId: pins.repositoryId, head: later },
        },
      },
    },
  });

  const bundle = await exportShare({ ...local, reviewId, repository });

  const file = sharedSources(bundle)!.files.find(
    (item) => item.path === "later.ts",
  );

  expect(file?.commit).toBe(later);
  expect(text(bundle, file!.object)).toBe("export const later = 1;\n");
});

it("skips binary and oversize files", async () => {
  const { local, reviewId } = await fixture();

  const bundle = await exportShare({
    ...local,
    data: exportData(local.data, {
      changes: (async (pins: Parameters<ShareExportData["changes"]>[0]) => [
        ...(await local.data.changes(pins)),
        {
          path: "image.png",
          status: "added",
          additions: 0,
          deletions: 0,
          binary: true,
        },
      ]) as ShareExportData["changes"],
      file: (async (...args: Parameters<ShareExportData["file"]>) => {
        const file = await local.data.file(...args);

        return args[2] === "new.ts"
          ? { ...file, text: "x".repeat(MAX_SHARE_OBJECT_BYTES + 1) }
          : file;
      }) as ShareExportData["file"],
    }),
    reviewId,
    repository,
  });

  const paths = sharedSources(bundle)!.files.map((file) => file.path);

  expect(paths).toContain("main.ts");
  expect(paths).not.toContain("new.ts");
  expect(paths).not.toContain("image.png");
});

it("embeds anchor files first and skips sources beyond the object budget", async () => {
  const { local, reviewId } = await fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  cleanup.push(async () => warn.mockRestore());

  const generated = Array.from(
    { length: MAX_SHARE_OBJECTS + 100 },
    (_, i) => `gen/${i}.ts`,
  );

  const bundle = await exportShare({
    ...local,
    data: exportData(local.data, {
      changes: (async (pins: Parameters<ShareExportData["changes"]>[0]) => [
        ...generated.map((path) => ({
          path,
          status: "added",
          additions: 1,
          deletions: 0,
          binary: false,
        })),
        ...(await local.data.changes(pins)),
      ]) as ShareExportData["changes"],
      file: (async (...args: Parameters<ShareExportData["file"]>) =>
        args[2].startsWith("gen/")
          ? { text: `export const file = "${args[2]}";\n` }
          : local.data.file(...args)) as ShareExportData["file"],
    }),
    reviewId,
    repository,
  });

  const { files } = sharedSources(bundle)!;
  const pins = local.store.read(reviewId).pins!;

  expect(bundle.manifest.objects.length).toBeLessThanOrEqual(MAX_SHARE_OBJECTS);
  expect(files.length).toBeLessThan(generated.length);
  expect(files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "main.ts", commit: pins.head }),
      expect.objectContaining({ path: "new.ts", commit: pins.head }),
    ]),
  );
  expect(warn).toHaveBeenCalled();
});

it("omits sources for a review without pins", async () => {
  const { local } = await fixture();

  const { reviewId } = await local.store.execute({
    operation: { type: "create", kind: "scratchpad", title: "Notes only" },
  });

  await local.store.execute({
    operation: {
      type: "edit",
      reviewId,
      edit: { type: "insert", content: { type: "markdown", markdown: "Hi" } },
    },
  });

  expect(sharedSources(await exportShare({ ...local, reviewId }))).toBe(
    undefined,
  );
});
