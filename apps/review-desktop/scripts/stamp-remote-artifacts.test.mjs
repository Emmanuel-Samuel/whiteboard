import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { REMOTE_TARGETS, remoteTarballName } from "./build-remote-tarball.mjs";
import { remoteArtifacts, remotePin, writePin } from "./stamp-remote-artifacts.mjs";

const SCRIPT = path.join(import.meta.dirname, "stamp-remote-artifacts.mjs");

const VERSION = "1.2.4-preview.20261013.7";

const BASE = `https://install.dev.fast/releases/${VERSION}/remote`;

const roots = [];

after(() =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(targets = REMOTE_TARGETS) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-stamp-remote-"));
  roots.push(root);
  const sums = {};

  for (const target of targets) {
    const name = remoteTarballName(VERSION, target);
    const content = `tarball for ${target}`;
    sums[target] = createHash("sha256").update(content).digest("hex");
    await writeFile(path.join(root, name), content);
    await writeFile(path.join(root, `${name}.sha256`), `${sums[target]}  ${name}\n`);
  }

  const productPath = path.join(root, "product.json");
  await writeFile(
    productPath,
    `${JSON.stringify({ nameShort: "Whiteboard" }, null, "\t")}\n`,
  );

  return { root, sums, productPath };
}

test("pins each target's tarball under the base URL with its .sha256", async () => {
  const { root, sums } = await fixture();

  const pin = execFileSync("node", [SCRIPT, root, VERSION, BASE], {
    encoding: "utf8",
  });

  assert.deepEqual(JSON.parse(pin), {
    version: VERSION,
    "linux-x64": {
      url: `${BASE}/whiteboard-remote-${VERSION}-linux-x64.tar.xz`,
      sha256: sums["linux-x64"],
    },
    "linux-arm64": {
      url: `${BASE}/whiteboard-remote-${VERSION}-linux-arm64.tar.xz`,
      sha256: sums["linux-arm64"],
    },
  });
});

test("refuses a directory missing a target", async () => {
  const { root } = await fixture(["linux-x64"]);

  await assert.rejects(remoteArtifacts(root, VERSION), /linux-arm64/);
});

test("pins from the .sha256 files alone, as a rerun downloads them", async () => {
  const { root, sums } = await fixture();

  for (const target of REMOTE_TARGETS)
    await rm(path.join(root, remoteTarballName(VERSION, target)));

  assert.equal((await remoteArtifacts(root, VERSION))["linux-x64"].sha256, sums["linux-x64"]);
});

test("refuses a .sha256 that names another tarball", async () => {
  const { root } = await fixture();
  const name = remoteTarballName(VERSION, "linux-x64");
  await writeFile(path.join(root, `${name}.sha256`), `${"0".repeat(64)}  other.tar.xz\n`);

  await assert.rejects(remoteArtifacts(root, VERSION), /linux-x64/);
});

test("--pinned writes the pin into product.json and refuses a malformed one", async () => {
  const { root, productPath } = await fixture();

  const pin = remotePin({
    version: VERSION,
    baseUrl: BASE,
    files: await remoteArtifacts(root, VERSION),
  });

  execFileSync("node", [SCRIPT, "--pinned", JSON.stringify(pin), "--product", productPath]);
  const product = JSON.parse(await readFile(productPath, "utf8"));
  assert.deepEqual(product.whiteboardRemote, pin);
  assert.equal(product.nameShort, "Whiteboard");

  const broken = { ...pin, "linux-arm64": { ...pin["linux-arm64"], sha256: "abc" } };
  assert.throws(() => writePin(broken, productPath), /linux-arm64/);
  assert.throws(() => writePin(undefined, productPath), /version/);
});
