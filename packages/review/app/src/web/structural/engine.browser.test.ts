import { afterEach, expect, it } from "vitest";

import { type StructuralEngine, createStructuralEngine } from "./engine";
import {
  brokenEngineUrl,
  fakeEngineUrl,
  malformedWorkerUrl,
} from "./test-engine";

const engineUrl = new URL("./engine/diffr_web_bg.wasm.gz", import.meta.url)
  .href;

const engines: StructuralEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

it("diffs a file structurally in a worker", async ({ skip }) => {
  const head = await fetch(engineUrl, { method: "HEAD" });

  if (!head.ok)
    skip(
      "The diffr engine is not built: run `cargo xtask build-web` in diffr and copy diffr_web_bg.wasm.gz into web/structural/engine.",
    );
  const engine = createStructuralEngine({ engineUrl });
  engines.push(engine);

  const { event, lines } = await engine.diff(
    "modified",
    { path: "src/a.ts", text: "line1\nline2\nline3\n" },
    { path: "src/a.ts", text: "line1\nline2\nline3\nconst added = 2;\n" },
  );

  expect(event.diff?.type).toBe("text");
  expect(
    event.diff?.type === "text" && event.diff.structural_changes?.head,
  ).toEqual([[3, 4]]);
  expect(lines[1].text).toContain("const added = 2;");
});

it("rejects every call when the engine cannot load", async () => {
  const engine = createStructuralEngine({
    engineUrl: new URL("./engine/missing.wasm", import.meta.url).href,
  });

  engines.push(engine);

  await expect(
    engine.diff("added", undefined, { path: "a.ts", text: "a\n" }),
  ).rejects.toThrow("failed to load");
});

it("lets idle workers go and starts one again for later work", async () => {
  const engine = createStructuralEngine({
    engineUrl: fakeEngineUrl(),
    workerUrl: malformedWorkerUrl(),
    idleMs: 20,
  });

  engines.push(engine);

  await engine.diff("added", undefined, { path: "a.ts", text: "a\n" });
  expect(engine.workers()).toBe(1);
  await expect.poll(() => engine.workers()).toBe(0);

  await engine.diff("added", undefined, { path: "a.ts", text: "a\n" });
  expect(engine.workers()).toBe(1);
});

it("stops spawning workers once the engine fails to compile", async () => {
  const engine = createStructuralEngine({
    engineUrl: brokenEngineUrl(),
    workerUrl: malformedWorkerUrl(),
    workers: 4,
  });

  engines.push(engine);
  const side = { path: "a.ts", text: "a\n" };

  const calls = [1, 2, 3, 4, 5].map(() =>
    engine.diff("added", undefined, side),
  );

  for (const call of calls) await expect(call).rejects.toThrow("WebAssembly");
  await expect(engine.diff("added", undefined, side)).rejects.toThrow(
    "WebAssembly",
  );
  expect(engine.workers()).toBe(0);
});
