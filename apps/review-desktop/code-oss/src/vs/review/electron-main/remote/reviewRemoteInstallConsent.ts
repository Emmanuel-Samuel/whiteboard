/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ReviewRemoteInstallAnswer = "allow" | "deny";

export interface ReviewRemoteInstallConsent {
	get(alias: string): Promise<ReviewRemoteInstallAnswer | undefined>;
	set(alias: string, answer: ReviewRemoteInstallAnswer): Promise<void>;
	forget(alias: string): Promise<void>;
}

type Stored = Record<string, ReviewRemoteInstallAnswer>;

export const reviewRemoteInstallConsentPath = (userDataPath: string) => join(userDataPath, "remote-install-consent.json");

export function openRemoteInstallConsent(path: string): ReviewRemoteInstallConsent {
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.then(run, run);
		queue = next.catch(() => undefined);
		return next;
	};

	async function read(): Promise<Stored> {
		// No prototype: a key such as `__proto__` is a plain entry.
		const stored: Stored = Object.create(null);
		let value: { aliases?: Record<string, unknown> };
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return stored;
		}
		for (const [alias, answer] of Object.entries(value?.aliases ?? {})) {
			if (answer === "allow" || answer === "deny") stored[alias] = answer;
		}
		return stored;
	}

	const update = (change: (stored: Stored) => void) =>
		serial(async () => {
			const stored = await read();
			const before = JSON.stringify(stored);
			change(stored);
			if (JSON.stringify(stored) === before) return;
			await mkdir(dirname(path), { recursive: true });
			const part = `${path}.${randomBytes(4).toString("hex")}.part`;
			try {
				await writeFile(part, JSON.stringify({ aliases: stored }), { mode: 0o600 });
				await rename(part, path);
			} finally {
				await rm(part, { force: true });
			}
		});

	return {
		get: (alias) => serial(async () => (await read())[alias]),
		set: (alias, answer) => update((stored) => void (stored[alias] = answer)),
		forget: (alias) => update((stored) => void delete stored[alias]),
	};
}
