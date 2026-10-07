/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import type { SpawnSsh } from "./reviewRemoteHost.js";
import { REVIEW_SSH_CONFIG_ENV, reviewSshSession } from "./reviewSshCommand.js";
import { uploadFile } from "./reviewRemoteUpload.js";

const run = promisify(execFile);
const harness = resolve(import.meta.dirname, "../../../../../../scripts/e2e/remote/remote.mjs");

function skipReason(): string | undefined {
	if (process.env.WB_TEST_CONTAINERS !== "1") return "set WB_TEST_CONTAINERS=1 to upload to a container";
	try {
		execFileSync("docker", ["info"], { stdio: "ignore" });
	} catch {
		return "Docker is not available";
	}
	return undefined;
}

const skip = skipReason();
const runId = `s3t2${randomBytes(3).toString("hex")}`;
const container = `wb-test-${runId}-a`;
const directory = "/home/dev/wb-upload";
const env = { ...process.env, WB_TEST_RUN: runId };
const sshEnv = { ...process.env, VSCODE_DEV: "1", [REVIEW_SSH_CONFIG_ENV]: `/tmp/wbt.${runId}/ssh_config` };
let root = "";
let local = "";
let expected = "";
let started = false;

const remote = (...args: string[]) => run(process.execPath, [harness, ...args], { env, maxBuffer: 16 << 20 });
const inContainer = async (command: string) => (await run("docker", ["exec", "-u", "dev", container, "sh", "-c", command])).stdout.trim();

before(
	async () => {
		if (skip) return;
		root = await mkdtemp(join(tmpdir(), "wb-upload-"));
		local = join(root, "payload.bin");
		const payload = randomBytes(40 << 20);
		expected = createHash("sha256").update(payload).digest("hex");
		await writeFile(local, payload);
		started = true;
		await remote("up", "a", "--sealed");
		await inContainer(`mkdir -p ${directory}`);
	},
	{ timeout: 20 * 60_000 },
);

after(
	async () => {
		if (started) await remote("down", "--all").catch((error) => console.error(error.stderr ?? error));
		if (root) await rm(root, { recursive: true, force: true });
	},
	{ timeout: 5 * 60_000 },
);

const session = () => reviewSshSession("wb-test-a", root, "test");

test("a 40 MB file lands on a sealed host with the checksum it left with", { skip, timeout: 120_000 }, async () => {
	const realSsh: SpawnSsh = (args, options) => spawn("ssh", args, options);
	const target = `${directory}/whole.bin`;

	await uploadFile(session(), local, target, { spawn: realSsh, env: sshEnv });

	assert.equal((await inContainer(`sha256sum ${target}`)).split(" ")[0], expected);
	assert.equal(await inContainer(`ls ${directory}`), "whole.bin");
});
