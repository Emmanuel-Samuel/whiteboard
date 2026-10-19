import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { askAgentTakesMcp, findExecutable } from "./agents.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-ask-agents-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", "/usr/bin:/bin");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "gives MCP to a Pi found, and run, only on the PATH it is handed",
  async () => {
    const bin = path.join(root, "login-bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "wbtest-node"),
      '#!/bin/sh\nexec /bin/sh "$@"\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, "pi"),
      "#!/usr/bin/env wbtest-node\necho 0.99.0\n",
      { mode: 0o755 },
    );

    expect(await askAgentTakesMcp("pi", { PATH: `${bin}:/usr/bin:/bin` })).toBe(
      true,
    );
    expect(await askAgentTakesMcp("pi")).toBe(false);
  },
);

async function installBin(name: string, directory = "bin") {
  const bin = path.join(root, directory);

  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, name), "", { mode: 0o755 });

  return bin;
}

it("finds a Windows executable by the extensions in PATHEXT", async () => {
  const bin = await installBin("claude.exe");

  expect(
    await findExecutable(
      "claude",
      { PATH: bin, PATHEXT: ".COM;.EXE" },
      "win32",
    ),
  ).toBe(path.join(bin, "claude.exe"));
});

it("falls back to .exe without PATHEXT, and reads Path in any case", async () => {
  const bin = await installBin("claude.exe");

  expect(await findExecutable("claude", { Path: bin }, "win32")).toBe(
    path.join(bin, "claude.exe"),
  );
});

it("does not offer a .cmd install on Windows, which cannot be spawned without a shell", async () => {
  const bin = await installBin("pi.cmd");

  expect(
    await findExecutable("pi", { PATH: bin, PATHEXT: ".EXE;.CMD" }, "win32"),
  ).toBeUndefined();
});

it("still finds a bare name on Windows", async () => {
  const bin = await installBin("codex");

  expect(await findExecutable("codex", { PATH: bin }, "win32")).toBe(
    path.join(bin, "codex"),
  );
});

it("does not try extensions off Windows", async () => {
  const bin = await installBin("claude.exe");

  expect(
    await findExecutable("claude", { PATH: bin, PATHEXT: ".EXE" }, "linux"),
  ).toBeUndefined();
});

it("skips package-manager bin directories on Windows too", async () => {
  const bin = await installBin("codex.exe", "node_modules/.bin");

  expect(await findExecutable("codex", { PATH: bin }, "win32")).toBeUndefined();
});
