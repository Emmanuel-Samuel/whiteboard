/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";
import { Emitter, Event } from "../../../base/common/event.js";
import { CommandsRegistry } from "../../../platform/commands/common/commands.js";
import type { IMainProcessService } from "../../../platform/ipc/common/mainProcessService.js";
import type { INotification, INotificationActions, INotificationService } from "../../../platform/notification/common/notification.js";
import { PersistentConnectionEventType, type PersistentConnectionEvent } from "../../../platform/remote/common/remoteAgentConnection.js";
import type { IStorageService } from "../../../platform/storage/common/storage.js";
import type { IWorkbenchEnvironmentService } from "../../../workbench/services/environment/common/environmentService.js";
import type { IRemoteAgentConnection, IRemoteAgentService } from "../../../workbench/services/remote/common/remoteAgentService.js";
import type { IStatusbarEntry, IStatusbarService } from "../../../workbench/services/statusbar/browser/statusbar.js";
import { RETRY_HOST_COMMAND, ReviewSourceWindowHostState, showSourceWindowHostState } from "./reviewSourceWindowHostState.js";
import type { ReviewWindowHosts } from "./reviewWindowAuthorityResolver.js";

const OFFLINE = "devbox offline";

function fakes() {
	const entries: IStatusbarEntry[] = [];
	const shown: INotification[] = [];
	const retried: string[] = [];
	let closed = 0;
	const statusbar = {
		addEntry: (entry: IStatusbarEntry) => {
			entries.push(entry);
			return { update: (next: IStatusbarEntry) => void entries.push(next), dispose: () => {} };
		},
	} as unknown as IStatusbarService;
	const notifications = {
		notify: (notification: INotification) => {
			const shownAt = shown.push({ ...notification }) - 1;
			return {
				onDidClose: Event.None,
				close: () => void closed++,
				updateMessage: (message: string) => void (shown[shownAt] = { ...shown[shownAt], message }),
				updateActions: (actions: INotificationActions) => void (shown[shownAt] = { ...shown[shownAt], actions }),
			};
		},
	} as unknown as INotificationService;
	let state: { state: string; detail?: string } = { state: "online" };
	let polls = 0;
	const hosts = { endpoint: async () => undefined, state: async () => (polls++, { alias: "devbox", ...state }) } as unknown as ReviewWindowHosts;
	const connection = new Emitter<PersistentConnectionEvent>();
	return {
		statusbar,
		notifications,
		hosts,
		connection: { onDidStateChange: connection.event } as unknown as IRemoteAgentConnection,
		retry: (alias: string) => void retried.push(alias),
		fire: (type: PersistentConnectionEventType) => connection.fire({ type } as PersistentConnectionEvent),
		set: (next: string, detail?: string) => void (state = { state: next, detail }),
		polls: () => polls,
		last: () => entries.at(-1),
		shown,
		retried,
		closed: () => closed,
	};
}

async function until(check: () => boolean) {
	while (!check()) await new Promise((resolve) => setTimeout(resolve, 1));
}
const labels = (notification: INotification | undefined) => notification?.actions?.primary?.map((action) => action.label);

test("shows the alias while online, the offline state within one poll, and restores it", async () => {
	const f = fakes();
	const watch = showSourceWindowHostState("abc-1", f.hosts, f.statusbar, f.notifications, f.connection, f.retry, undefined, 5);
	try {
		await until(() => f.last()?.text === "devbox");
		assert.notEqual(f.last()?.kind, "warning");
		assert.equal(f.last()?.command, undefined);
		assert.equal(f.shown.length, 0);

		f.set("offline");
		await until(() => f.last()?.text === OFFLINE);
		assert.equal(f.last()?.kind, "warning");
		assert.equal(f.last()?.command, RETRY_HOST_COMMAND);
		assert.deepEqual(f.shown.map((n) => [n.message, labels(n)]), [["devbox offline.", ["Retry"]]]);

		f.fire(PersistentConnectionEventType.ConnectionLost);
		f.set("online");
		const polls = f.polls();
		await until(() => f.polls() >= polls + 2);
		assert.equal(f.last()?.text, OFFLINE, "the window's own connection is still down");
		assert.equal(f.closed(), 0);

		f.fire(PersistentConnectionEventType.ConnectionGain);
		assert.equal(f.last()?.text, "devbox");
		assert.notEqual(f.last()?.kind, "warning");
		assert.equal(f.closed(), 1);

		f.set("unreachable", "ssh: connect to host devbox port 22: Connection refused");
		await until(() => f.shown.length === 2);
		assert.equal(f.last()?.text, OFFLINE);
		assert.deepEqual(f.shown.map((n) => n.message), ["devbox offline.", "ssh: connect to host devbox port 22: Connection refused"], "a later outage notifies again");
	} finally {
		watch.dispose();
	}
});

test("Retry in the notice and the status bar retries the host", async () => {
	const f = fakes();
	f.set("offline");
	const watch = showSourceWindowHostState("abc-1", f.hosts, f.statusbar, f.notifications, f.connection, f.retry, undefined, 5);
	try {
		await until(() => f.shown.length === 1);
		await f.shown[0]?.actions?.primary?.[0]?.run();
		await CommandsRegistry.getCommand(RETRY_HOST_COMMAND)?.handler(undefined as never);
		assert.deepEqual(f.retried, ["devbox", "devbox"]);
	} finally {
		watch.dispose();
	}
});

test("a host that refuses its sign-in is named so, with no Retry, and the open notice follows the state", async () => {
	const f = fakes();
	f.set("offline");
	const watch = showSourceWindowHostState("abc-1", f.hosts, f.statusbar, f.notifications, f.connection, f.retry, undefined, 5);
	try {
		await until(() => f.last()?.text === OFFLINE);
		f.set("auth-failed", "Permission denied (publickey).");
		await until(() => f.last()?.text === "Can't sign in to devbox");
		assert.equal(f.last()?.command, undefined);
		assert.deepEqual(f.shown.map((n) => [n.message, labels(n)]), [["Permission denied (publickey).", []]]);
	} finally {
		watch.dispose();
	}
});

test("a window restored before main knows its host's alias names it by the alias it stored when it opened", async () => {
	const stored = new Map<string, string>();
	const storage = { get: (key: string) => stored.get(key), store: (key: string, value: string) => stored.set(key, value) } as unknown as IStorageService;
	const open = (state: object) => {
		const f = fakes();
		const contribution = new ReviewSourceWindowHostState(
			{ remoteAuthority: "whiteboard+3f454168-aaaa" } as IWorkbenchEnvironmentService,
			{ getChannel: () => ({ call: async (command: string) => (command === "getRemoteHostState" ? state : undefined) }) } as unknown as IMainProcessService,
			f.statusbar,
			f.notifications,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
			storage,
		);
		return { f, contribution };
	};
	const first = open({ alias: "wb-test-a", state: "online" });
	await until(() => first.f.last()?.text === "wb-test-a");
	first.contribution.dispose();
	const { f, contribution } = open({ state: "offline" });
	try {
		await until(() => f.last()?.text === "wb-test-a offline");
		assert.equal(f.shown[0]?.message, "wb-test-a offline.");
	} finally {
		contribution.dispose();
	}
});
