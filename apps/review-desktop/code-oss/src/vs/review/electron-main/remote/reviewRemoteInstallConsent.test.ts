/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openRemoteInstallConsent } from "./reviewRemoteInstallConsent.js";

async function file(t: test.TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "wb-consent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "remote-install-consent.json");
}

test("an answer is kept per alias, owner-only, until the user changes it", async (t) => {
	const path = await file(t);
	const consent = openRemoteInstallConsent(path);

	await consent.set("box", "deny");
	assert.equal(await openRemoteInstallConsent(path).get("box"), "deny");
	await consent.set("box", "allow");
	assert.equal(await consent.get("box"), "allow");
	assert.equal(await consent.get("other"), undefined);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { aliases: { box: "allow" } });
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("an unreadable file is no consent, and is replaced on the next answer", async (t) => {
	const path = await file(t);
	await writeFile(path, "{not json");
	const consent = openRemoteInstallConsent(path);

	assert.equal(await consent.get("box"), undefined);
	await consent.set("box", "allow");
	assert.equal(await consent.get("box"), "allow");
});
