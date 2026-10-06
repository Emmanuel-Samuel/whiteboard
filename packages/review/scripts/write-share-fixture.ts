/** Writes the peek-and-diff review as a share bundle directory for cloudboard's dev mode and e2e. */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { gitShareFixture } from "@review/sharing/export-fixtures.js";
import { exportShare } from "@review/sharing/export.js";

const [outDir] = process.argv.slice(2).map((arg) => path.resolve(arg));

if (!outDir)
  throw new Error("Usage: tsx scripts/write-share-fixture.ts <outDir>");

const review = JSON.parse(
  await readFile(
    path.join(
      import.meta.dirname,
      "../app/src/fixtures/shares/peek-and-diff.json",
    ),
    "utf8",
  ),
);

const texts = (commit: string) =>
  Object.fromEntries(
    review.sources.files
      .filter((file: { commit: string }) => file.commit === commit)
      .map((file: { path: string; text: string }) => [file.path, file.text]),
  );

const fixture = await gitShareFixture(
  await mkdtemp(path.join(os.tmpdir(), "share-fixture-")),
  {
    title: review.title,
    base: texts(review.pins.base),
    head: texts(review.pins.head),
  },
);

try {
  await fixture.insert(review.document);

  for (const { title, targets } of review.lenses)
    await fixture.lens({ type: "insert", title, targets });

  const bundle = await exportShare({
    ...fixture.local,
    reviewId: fixture.reviewId,
    repository: { cloneUrl: "https://github.com/fixture/review.git" },
  });

  await mkdir(path.join(outDir, "objects"), { recursive: true });
  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(bundle.manifest, null, 2) + "\n",
  );
  await writeFile(
    path.join(outDir, "share.json"),
    JSON.stringify({ sender: { login: "octocat" }, sharedAt: 1791244800000 }) +
      "\n",
  );
  await writeFile(
    path.join(outDir, "capability.txt"),
    randomBytes(32).toString("base64url") + "\n",
  );

  for (const [id, bytes] of bundle.objects)
    await writeFile(path.join(outDir, "objects", id), bytes);
} finally {
  await fixture.close();
}
