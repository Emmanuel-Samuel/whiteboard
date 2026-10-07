/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import * as semver from "../../../base/common/semver/semver.js";

import type { ReviewRemoteArtifact } from "./reviewRemoteArtifacts.js";
import { lastLine, runSsh, type RunResult, type SpawnSsh, type SshChildProcess } from "./reviewRemoteHost.js";
import {
	cleanupScript,
	completeScript,
	finishScript,
	lockScript,
	prepareScript,
	releaseScript,
	REVIEW_REMOTE_INSTALL_SAY,
	REVIEW_REMOTE_LOCK_STALE_SECONDS,
	REVIEW_REMOTE_VERSION,
	REVIEW_REMOTE_WRAPPER_MARK,
	reviewRemoteVersionDir,
	shellQuote,
	unpackScript,
	type ReviewRemoteInstallContext,
} from "./reviewRemoteInstallScript.js";
import { missingInstallTools, type ReviewRemoteProbe, type ReviewRemoteTarget } from "./reviewRemoteProbe.js";
import { sshExecArgs, type ReviewSshSession } from "./reviewSshCommand.js";

export interface ReviewRemoteInstallProgress {
	step: "waiting-for-lock" | "package" | "done";
}

const REVIEW_REMOTE_INSTALL_TIMEOUTS = {
	step: 30_000,
	fetch: 25 * 60_000,
	lockWait: REVIEW_REMOTE_LOCK_STALE_SECONDS * 1000,
	lockStale: REVIEW_REMOTE_LOCK_STALE_SECONDS * 1000,
	lockPoll: 2_000,
	release: 15_000,
};

export interface ReviewRemoteInstallInput {
	readonly session: ReviewSshSession;
	readonly probe: ReviewRemoteProbe;
	readonly target: ReviewRemoteTarget;
	readonly version: string;
	onProgress(progress: ReviewRemoteInstallProgress): void;
	readonly signal: AbortSignal;
	readonly artifact: ReviewRemoteArtifact;
	readonly spawn: SpawnSsh;
	readonly env: NodeJS.ProcessEnv;
	readonly owner?: string;
	readonly timeouts?: Partial<typeof REVIEW_REMOTE_INSTALL_TIMEOUTS>;
}

export interface ReviewRemoteInstallResult {
	readonly cliPath: string;
	readonly nodePath: string;
}

export async function installRemote(input: ReviewRemoteInstallInput): Promise<ReviewRemoteInstallResult> {
	const { session, probe, signal, artifact } = input;
	const timeouts = { ...REVIEW_REMOTE_INSTALL_TIMEOUTS, ...input.timeouts };
	const alias = session.alias;
	signal.throwIfAborted();
	// The marker is JSON read back with sed: no quote or backslash in any path it holds.
	for (const path of [probe.home, probe.root]) {
		if (/['"\\]/.test(path)) throw new Error(`Whiteboard cannot install on ${alias}: ${JSON.stringify(path)} holds a quote or backslash.`);
	}
	if (!REVIEW_REMOTE_VERSION.test(input.version)) throw new Error(`${JSON.stringify(input.version)} is not a version.`);
	const { sha256 } = artifact;
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${artifact.name} has no sha256.`);
	if (!artifact.name.endsWith(`-${input.target}.tar.xz`)) throw new Error(`${artifact.name} is not the tarball for ${input.target}.`);

	const context: ReviewRemoteInstallContext = { home: probe.home, root: probe.root, token: randomBytes(8).toString("hex") };
	const owner = (input.owner ?? hostname()).replace(/[^\w.-]/g, "-").slice(0, 64) || "unknown";

	const children = new Set<SshChildProcess>();
	const tracked: SpawnSsh = (args, options) => {
		const child = input.spawn(args, options);
		children.add(child);
		child.once("close", () => children.delete(child));
		return child;
	};
	const onAbort = () => {
		for (const child of children) {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
	};
	signal.addEventListener("abort", onAbort, { once: true });

	const run = async (what: string, script: string, timeout = timeouts.step): Promise<Answer> => {
		signal.throwIfAborted();
		const result = await runSsh(tracked, input.env, sshExecArgs(session, input.env), timeout, script);
		signal.throwIfAborted();
		return answer(alias, what, result, timeout);
	};

	let locking = false;
	try {
		let result = await alreadyComplete();
		if (!result) {
			const missing = missingInstallTools(probe, alias);
			if (missing || !probe.downloader) throw new Error(missing);
			locking = true;
			await takeLock();
			result = await install(probe.downloader);
		}
		input.onProgress({ step: "done" });
		return result;
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (locking) await runSsh(input.spawn, input.env, sshExecArgs(session, input.env), timeouts.release, releaseScript(context));
	}

	async function alreadyComplete(): Promise<ReviewRemoteInstallResult | undefined> {
		const checked = await run("checking the installed version", completeScript(context, { version: input.version, sha256 })).catch((error: unknown) => {
			if (signal.aborted) throw error;
			return undefined;
		});
		return checked?.has("COMPLETE") ? readMarker(checked.get("MARKER")) : undefined;
	}

	async function takeLock(): Promise<void> {
		const deadline = Date.now() + timeouts.lockWait;
		let told = false;
		for (;;) {
			const says = await run("taking the install lock", lockScript(context, owner, Math.ceil(timeouts.lockStale / 1000)));
			if (says.has("LOCKED")) return;
			const holder = says.get("BUSY");
			if (holder === undefined) throw says.failure();
			if (Date.now() >= deadline) {
				throw new Error(`Another install on ${alias} (${holder || "unknown"}) held the lock for ${timeouts.lockWait / 60_000} minutes.`);
			}
			if (!told) input.onProgress({ step: "waiting-for-lock" });
			told = true;
			await delay(timeouts.lockPoll, signal);
		}
	}

	async function install(downloader: "curl" | "wget"): Promise<ReviewRemoteInstallResult> {
		const prepared = await run("preparing", prepareScript(context, { version: input.version, sha256 }));
		if (!prepared.has("PREPARED")) throw prepared.failure();
		if (prepared.has("COMPLETE")) {
			const marker = readMarker(prepared.get("MARKER"));
			if (!marker) throw new Error(`The install marker on ${alias} for ${input.version} cannot be read.`);
			return marker;
		}

		input.onProgress({ step: "package" });
		const unpacked = await run(
			`downloading and unpacking ${artifact.name}`,
			unpackScript(context, { version: input.version, sha256, url: artifact.url, downloader }),
			timeouts.fetch,
		);
		const mismatch = unpacked.get("MISMATCH");
		if (mismatch !== undefined) {
			throw new Error(`The tarball on ${alias} does not match its pinned checksum${mismatch ? "" : " (no checksum tool answered)"}; it was removed.`);
		}
		if (!unpacked.has("UNPACKED")) throw unpacked.failure();
		const reported = parseVersion(unpacked.get("VERSION"));
		if (reported !== input.version) {
			throw new Error(`The tarball installed on ${alias} reports version ${reported ?? "nothing"}, not ${input.version}.`);
		}

		const dir = reviewRemoteVersionDir(probe.root, input.version);
		const result = { nodePath: `${dir}/bin/node`, cliPath: `${dir}/dist/cli.js` };
		const have = prepared.all("HAVE").filter((name) => REVIEW_REMOTE_VERSION.test(name));
		const newest = [input.version, ...have].sort(semver.compare).at(-1);
		const finished = await run(
			"finishing",
			finishScript(context, {
				version: input.version,
				marker: JSON.stringify({ version: input.version, sha256, node: result.nodePath, cli: result.cliPath, installedAt: Math.floor(Date.now() / 1000) }),
				wrapper: newest === input.version ? `#!/bin/sh\n${REVIEW_REMOTE_WRAPPER_MARK}\nexec ${shellQuote(`${dir}/whiteboard`)} "$@"\n` : undefined,
			}),
		);
		if (!finished.has("COMPLETE")) throw finished.failure();

		const keep = new Set([input.version, newest]);
		const candidates = have.filter((name) => !keep.has(name)).sort(semver.rcompare);
		if (candidates.length) {
			await run("removing old versions", cleanupScript(context, { candidates, room: 2 - keep.size })).catch((error: unknown) => {
				if (signal.aborted) throw error;
			});
		}
		return result;
	}
}

interface Answer {
	has(word: string): boolean;
	get(word: string): string | undefined;
	all(word: string): string[];
	failure(): Error;
}

function answer(alias: string, what: string, result: RunResult, timeout: number): Answer {
	const says = result.stdout.split("\n").flatMap((line) => {
		if (!line.startsWith(`${REVIEW_REMOTE_INSTALL_SAY} `)) return [];
		const rest = line.slice(REVIEW_REMOTE_INSTALL_SAY.length + 1);
		const space = rest.indexOf(" ");
		return [space < 0 ? [rest, ""] : [rest.slice(0, space), rest.slice(space + 1)]];
	});
	const all = (word: string) => says.filter(([said]) => said === word).map(([, value]) => value);
	return {
		has: (word) => all(word).length > 0,
		get: (word) => all(word).at(-1),
		all,
		failure() {
			const reason = all("FAIL").at(-1);
			if (reason) return new Error(`Installing on ${alias} failed while ${what}: ${reason}.`);
			if (result.timedOut) return new Error(`Installing on ${alias} failed: ${what} took longer than ${timeout / 1000} seconds.`);
			if (result.error) return new Error(`Installing on ${alias} failed while ${what}: ${result.error.message}`);
			const stderr = lastLine(result.stderr);
			return new Error(`Installing on ${alias} failed while ${what}: exit ${result.code}${stderr ? `: ${stderr}` : ""}.`);
		},
	};
}

function readMarker(text: string | undefined): ReviewRemoteInstallResult | undefined {
	try {
		const marker = JSON.parse(text ?? "") as { node?: unknown; cli?: unknown };
		if (typeof marker.node === "string" && typeof marker.cli === "string") return { nodePath: marker.node, cliPath: marker.cli };
	} catch {
	}
	return undefined;
}

function parseVersion(text: string | undefined): string | undefined {
	try {
		const value = JSON.parse(text ?? "") as { version?: unknown };
		return typeof value.version === "string" ? value.version : undefined;
	} catch {
		return undefined;
	}
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", stop, { once: true });
	});
}
