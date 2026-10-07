/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { lastLine, type SpawnSsh } from "./reviewRemoteHost.js";
import { shellQuote } from "./reviewRemoteInstallScript.js";
import { sshExecArgs, type ReviewSshSession } from "./reviewSshCommand.js";

export const REVIEW_REMOTE_UPLOAD_TIMEOUTS = {
	stall: 30_000,
	flush: 120_000,
};

export interface ReviewRemoteUploadOptions {
	readonly spawn: SpawnSsh;
	readonly env: NodeJS.ProcessEnv;
	readonly timeouts?: Partial<typeof REVIEW_REMOTE_UPLOAD_TIMEOUTS>;
}

export async function uploadFile(session: ReviewSshSession, localPath: string, remotePath: string, options: ReviewRemoteUploadOptions): Promise<void> {
	const timeouts = { ...REVIEW_REMOTE_UPLOAD_TIMEOUTS, ...options.timeouts };
	const total = (await stat(localPath)).size;
	const where = `The upload of ${localPath} to ${session.alias}:${remotePath}`;
	return new Promise((resolve, reject) => {
		const args = sshExecArgs(session, options.env, ["sh", "-c", `'cat > "$1.part" && mv -f "$1.part" "$1"'`, "sh", shellQuote(remotePath)]);
		let child: ReturnType<SpawnSsh>;
		try {
			child = options.spawn(args, { env: options.env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
		} catch (error) {
			return reject(new Error(`${where} could not start: ${(error as Error).message}`));
		}
		const file = createReadStream(localPath);
		const stdin = child.stdin!;
		let sent = 0;
		let stderr = "";
		let failure: string | undefined;
		let stall: ReturnType<typeof setTimeout>;
		const watch = (ms: number, what: string) => {
			clearTimeout(stall);
			stall = setTimeout(() => {
				failure = `stalled: ${what} for ${ms / 1000} seconds`;
				child.kill("SIGKILL");
			}, ms);
		};
		const accepted = () => watch(timeouts.stall, "ssh took nothing from its stdin");
		accepted();

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(0, 4096)));
		stdin.on("error", () => {});
		file.on("error", (error) => {
			failure = `reading the file failed: ${error.message}`;
			child.kill("SIGKILL");
		});
		file.on("data", (chunk) => {
			sent += chunk.length;
			if (stdin.write(chunk)) return accepted();
			file.pause();
			stdin.once("drain", () => {
				accepted();
				file.resume();
			});
		});
		file.on("end", () => {
			stdin.end();
			watch(timeouts.flush, "ssh did not finish sending what it held");
		});
		child.once("exit", () => {
			file.destroy();
			stdin.destroy();
		});
		child.once("error", (error: Error) => {
			failure ??= `ssh could not start: ${error.message}`;
		});
		child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
			clearTimeout(stall);
			if (!failure && code === 0 && sent === total) return resolve();
			const reason = failure ?? (code === 0 ? `the file changed while it was sent (${sent} of ${total} bytes)` : `ssh ${signal ? `was stopped (${signal})` : `exited with ${code}`}${lastLine(stderr) && `: ${lastLine(stderr)}`}`);
			reject(new Error(`${where} did not finish after ${sent} of ${total} bytes: ${reason}.`));
		});
	});
}
