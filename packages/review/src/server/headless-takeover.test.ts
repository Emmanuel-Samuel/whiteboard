import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { processStartIdentity } from "@dev.fast/trace-core";
import {
  headlessServerLockPath,
  reviewServerDiscoveryPath,
} from "@review/server-discovery.js";
import { afterEach, beforeEach, expect, it } from "vitest";

import { takeOverServerHome } from "./headless-host.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await realpath(await mkdtemp(path.join(tmpdir(), "wb-take-")));
});

afterEach(() => rm(stateDir, { recursive: true, force: true }));

it("takes over a home recorded for a reused pid without signalling that process", async () => {
  const bystander = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 60000)",
  ]);

  try {
    const lock = headlessServerLockPath(stateDir);
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: bystander.pid, started: null }),
    );

    const file = reviewServerDiscoveryPath(stateDir);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        instanceId: crypto.randomUUID(),
        url: "http://127.0.0.1:9",
        serverPid: bystander.pid,
        token: "stale",
        startedBy: "cli",
      }),
    );

    const outcome = await takeOverServerHome(stateDir, async () => "desktop", {
      timeoutMs: 300,
    }).catch((error: Error) => error.message);

    // Where a start time can prove the holder is another process the lock is
    // reclaimed; where none exists (Windows) too, after the wait. Otherwise the
    // holder is trusted and takeover refuses.
    const reclaimed = processStartIdentity(bystander.pid!) === null;

    expect(outcome === "desktop").toBe(reclaimed);

    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
  } finally {
    bystander.kill("SIGKILL");
  }
}, 30_000);
