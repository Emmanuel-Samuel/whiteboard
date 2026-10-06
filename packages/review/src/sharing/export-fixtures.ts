import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JsonObject } from "@dev.fast/review-protocol";
import type { LensEdit } from "@review/review-api/diff-lenses.js";
import { openLocalReviewStore } from "@review/review-api/local-data.js";

/** One commit: a path to its new text, or null to delete it. */
export type FixtureCommit = Record<string, string | null>;

/** A Git repository with a base and a head commit and a review pinned to them, in `root`. */
export async function gitShareFixture(
  root: string,
  {
    title,
    branch = "main",
    base,
    head,
    moves = {},
  }: {
    title: string;
    branch?: string;
    base: FixtureCommit;
    head: FixtureCommit;
    moves?: Record<string, string>;
  },
) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const commit = async (
    files: FixtureCommit,
    message: string,
    renames: Record<string, string> = {},
  ) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) continue;
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
      await writeFile(path.join(repo, file), text);
    }

    git("add", ".");

    for (const [from, to] of Object.entries(renames)) git("mv", from, to);

    for (const [file, text] of Object.entries(files))
      if (text === null) git("rm", file);

    git("commit", "-m", message);

    return git("rev-parse", "HEAD");
  };

  git("init");
  git("checkout", "-b", branch);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const baseCommit = await commit(base, "base");
  const headCommit = await commit(head, "head", moves);
  const local = openLocalReviewStore(path.join(root, "review.db"));
  const repository = await local.data.register(repo);

  const pins = {
    repositoryId: repository.id,
    base: baseCommit,
    head: headCommit,
  };

  const { reviewId } = await local.store.execute({
    operation: { type: "create", title, target: { kind: "commits", ...pins } },
  });

  return {
    root,
    repo,
    local,
    reviewId,
    pins,
    async insert(contents: JsonObject[]) {
      for (const content of contents)
        await local.store.execute({
          operation: {
            type: "edit",
            reviewId,
            edit: { type: "insert", content },
          },
        });
    },
    async lens(edit: Extract<LensEdit, { type: "insert" }>) {
      await local.store.execute({
        operation: { type: "lens_edit", reviewId, edit },
      });
    },
    async close() {
      local.store.close();
      local.data.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
