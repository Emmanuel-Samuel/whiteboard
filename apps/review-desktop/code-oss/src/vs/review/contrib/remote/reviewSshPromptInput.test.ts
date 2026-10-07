/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import test from "node:test";

import { createSshPromptInput } from "./reviewSshPromptInput.js";

function fakeInput() {
	const handlers: Record<string, () => void> = {};
	const on = (name: string) => (handler: () => void) => {
		handlers[name] = handler;
		return { dispose() {} };
	};
	return {
		handlers,
		value: "",
		selectedItems: [] as { answer: string }[],
		onDidAccept: on("accept"),
		onWillHide: on("willHide"),
	} as Record<string, unknown> & { handlers: Record<string, () => void>; value: string; selectedItems: { answer: string }[] };
}

function create(kind: "secret" | "confirm" | "text" | "install", text: string) {
	const input = fakeInput();
	const answers: (string | undefined)[] = [];
	const service = { createInputBox: () => input, createQuickPick: () => input } as never;
	createSshPromptInput(service, { id: 1, alias: "wb-test-a", text, kind }, "SSH: wb-test-a", (answer) => answers.push(answer), { install: "Install", decline: "Don't install" });
	return { input, answers };
}

test("ssh's text is shown as plain description, never as the prompt that renders links", () => {
	const text = "[x](command:workbench.action.terminal.new) $(zap) Verification code: ";
	for (const kind of ["secret", "confirm", "text"] as const) {
		const { input } = create(kind, text);
		assert.equal(input.description, text);
		assert.equal(input.prompt, undefined);
		assert.equal(input.title, "SSH: wb-test-a");
	}
});

test("a secret is hidden, answered with what was typed, and cleared before the widget hides", () => {
	const { input, answers } = create("secret", "dev@127.0.0.1's password: ");
	assert.equal(input.password, true);

	input.value = "typed";
	input.handlers.accept();
	input.handlers.willHide();

	assert.deepEqual(answers, ["typed"]);
	assert.equal(input.value, "");
});

test("a confirm prompt answers with the picked yes or no", () => {
	const { input, answers } = create("confirm", "Are you sure you want to continue connecting (yes/no/[fingerprint])? ");
	input.selectedItems = [{ answer: "no" }];
	input.handlers.accept();
	assert.deepEqual(answers, ["no"]);
});

test("an install prompt offers Install and Don't install, and answers which was picked", () => {
	const { input, answers } = create("install", "Whiteboard 0.1.6 is not installed on wb-test-a.");
	assert.deepEqual(
		(input.items as { label: string }[]).map((item) => item.label),
		["Install", "Don't install"],
	);
	input.selectedItems = [(input.items as { answer: string }[])[1]];
	input.handlers.accept();
	assert.deepEqual(answers, ["decline"]);
});
