/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ReviewRegistryRelay {
	readonly port: number;
	close(): Promise<void>;
}

export const REVIEW_REGISTRY = "https://registry.npmjs.org";

const UPSTREAM_TIMEOUT = 120_000;

export async function startRegistryRelay(options: { upstream?: string } = {}): Promise<ReviewRegistryRelay> {
	const upstream = options.upstream ?? REVIEW_REGISTRY;
	const pending = new Set<AbortController>();

	const server = createServer((req, res) => {
		const abort = new AbortController();
		pending.add(abort);
		res.once("close", () => {
			abort.abort();
			pending.delete(abort);
		});
		relay(req, res, abort.signal).catch(() => (res.headersSent ? res.destroy() : reply(res, 502)));
	});

	async function relay(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
		if (req.method !== "GET") return reply(res, 405);
		const path = req.url ?? "";
		const response = await fetch(`${upstream}${path}`, {
			headers: { accept: req.headers.accept ?? "application/json" },
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT)]),
		});
		if (!response.body) return reply(res, 502);
		const type = response.headers.get("content-type");
		if (type) res.setHeader("content-type", type);
		res.statusCode = response.status;
		if (path.endsWith(".tgz") || !response.ok) return pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
		res.end(rewrite(await response.text(), `${upstream}/`, `http://${req.headers.host}/`));
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	return {
		port: (server.address() as AddressInfo).port,
		close: () =>
			new Promise<void>((resolve) => {
				for (const abort of pending) abort.abort();
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}

function reply(res: ServerResponse, status: number): void {
	res.statusCode = status;
	res.end();
}

function rewrite(text: string, from: string, to: string): string {
	const packument = JSON.parse(text) as { versions?: Record<string, { dist?: { tarball?: unknown } }> };
	for (const version of Object.values(packument.versions ?? {})) {
		const dist = version?.dist;
		if (dist && typeof dist.tarball === "string" && dist.tarball.startsWith(from)) dist.tarball = to + dist.tarball.slice(from.length);
	}
	return JSON.stringify(packument);
}
