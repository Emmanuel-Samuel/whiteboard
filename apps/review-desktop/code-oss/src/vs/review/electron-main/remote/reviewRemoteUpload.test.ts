/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { SpawnSsh } from "./reviewRemoteHost.js";
import { reviewSshSession } from "./reviewSshCommand.js";
import { uploadFile } from "./reviewRemoteUpload.js";

const roots: string[] = [];

after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wb upload "));
	roots.push(root);
	return root;
}

const localSsh =
	({ rewrite = (command: string) => command }: { rewrite?: (command: string) => string } = {}): SpawnSsh =>
	(args, options) =>
		spawn("/bin/sh", ["-c", rewrite(args.slice(args.indexOf("--") + 2).join(" "))], options);

const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
const session = reviewSshSession("devbox", tmpdir(), "test");

async function fixture(bytes = 4 << 20) {
	const root = await temporary();
	const local = join(root, "local.bin");
	const content = randomBytes(bytes);
	await writeFile(local, content);
	return { root, local, content, target: join(root, "remote file.tgz") };
}

test("the file lands under its name with every byte", async () => {
	const { root, local, content, target } = await fixture();

	await uploadFile(session, local, target, { spawn: localSsh(), env });

	assert.deepEqual(await readFile(target), content);
	assert.deepEqual((await readdir(root)).sort(), ["local.bin", "remote file.tgz"]);
});

test("an upload whose ssh ends halfway leaves only the .part file", async () => {
	const { root, local, target } = await fixture();
	const spawnSsh = localSsh({ rewrite: (command) => command.replace('cat > "$1.part"', 'head -c 1000 > "$1.part"; exit 1') });

	await assert.rejects(uploadFile(session, local, target, { spawn: spawnSsh, env }), /upload of .* to devbox/);

	assert.deepEqual((await readdir(root)).sort(), ["local.bin", "remote file.tgz.part"]);
});

test("a slow remote that keeps reading is not a stall, and one that stops reading is", async () => {
	const { local, content, target } = await fixture(1 << 20);
	const slow = localSsh({
		rewrite: (command) =>
			command.replace(
				'cat > "$1.part"',
				': > "$1.part"; while n=$(dd bs=65536 count=1 2>/dev/null | tee -a "$1.part" | wc -c) && [ $n -gt 0 ]; do sleep 0.2; done',
			),
	});

	await uploadFile(session, local, target, { spawn: slow, env, timeouts: { stall: 3_000 } });
	assert.deepEqual(await readFile(target), content);

	const stopped = localSsh({ rewrite: (command) => command.replace('cat > "$1.part"', 'sleep 2; cat > "$1.part"') });
	await assert.rejects(
		uploadFile(session, local, `${target}.2`, { spawn: stopped, env, timeouts: { stall: 300 } }),
		/stalled: ssh took nothing from its stdin/,
	);
});
