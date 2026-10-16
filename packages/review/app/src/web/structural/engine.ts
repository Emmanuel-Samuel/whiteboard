// Adapted from diffr (MIT) web/src/engine.ts at 62575763d.
import type { Diffed } from "./diffed";
import type { FileChange } from "./wire";
import type { WorkerRequest, WorkerResponse } from "./worker";

export type { Diffed };

export type StructuralStatus = FileChange["status"];

export interface StructuralSide {
  path: string;
  text: string;
}

export interface StructuralEngine {
  diff(
    status: StructuralStatus,
    lhs: StructuralSide | undefined,
    rhs: StructuralSide | undefined,
  ): Promise<Diffed>;
  dispose(): void;
}

interface Call {
  slot: Slot;
  resolve(result: Diffed): void;
  reject(error: Error): void;
}

interface Slot {
  worker: Worker;
  busy: number;
  retire: boolean;
}

const MEMORY_LIMIT = 512 * 1024 * 1024;

async function compile(engineUrl: string) {
  const response = await fetch(engineUrl);

  if (!response.ok || !response.body)
    throw new Error(`The diffr engine failed to load (${response.status}).`);
  const [peek, body] = response.body.tee();
  const reader = peek.getReader();
  const { value } = await reader.read();
  void reader.cancel();
  const gzipped = !!value && value[0] === 0x1f && value[1] === 0x8b;

  return WebAssembly.compileStreaming(
    new Response(
      gzipped ? body.pipeThrough(new DecompressionStream("gzip")) : body,
      { headers: { "content-type": "application/wasm" } },
    ),
  );
}

export function createStructuralEngine({
  engineUrl,
  workerUrl,
  workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)),
}: {
  engineUrl: string;
  workerUrl?: string | URL;
  workers?: number;
}): StructuralEngine {
  const pending = new Map<number, Call>();
  const slots: Slot[] = [];
  let module: Promise<WebAssembly.Module> | undefined;
  let next = 0;
  let disposed = false;

  const fail = (error: Error, slot?: Slot) => {
    for (const [id, call] of pending)
      if (!slot || call.slot === slot) {
        pending.delete(id);
        call.reject(error);
      }
  };

  const drop = (slot: Slot) => {
    const index = slots.indexOf(slot);

    if (index >= 0) slots.splice(index, 1);
    slot.worker.terminate();
  };

  const spawn = (): Slot => {
    const worker = workerUrl
      ? new Worker(workerUrl, { type: "module" })
      : new Worker(new URL("./worker.ts", import.meta.url), {
          type: "module",
        });

    const slot: Slot = { worker, busy: 0, retire: false };

    void module!.then(
      (compiled) =>
        worker.postMessage({ module: compiled } satisfies WorkerRequest),
      () => {},
    );
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      slot.busy--;

      if ("error" in data || data.memory > MEMORY_LIMIT) slot.retire = true;

      if (slot.retire && !slot.busy) drop(slot);

      const call = pending.get(data.id);
      pending.delete(data.id);

      if (!call) return;

      if ("error" in data) call.reject(new Error(data.error));
      else call.resolve(data);
    };

    worker.onerror = (event) => {
      event.preventDefault();
      drop(slot);
      fail(new Error(event.message || "The diffr worker failed."), slot);
    };

    return slot;
  };

  const pick = () => {
    const open = slots.filter((slot) => !slot.retire);

    const idle = open.reduce<Slot | undefined>(
      (best, slot) => (!best || slot.busy < best.busy ? slot : best),
      undefined,
    );

    if (idle && (idle.busy < 2 || slots.length >= workers)) return idle;
    const slot = spawn();
    slots.push(slot);

    return slot;
  };

  return {
    diff(status, lhs, rhs) {
      if (disposed)
        return Promise.reject(new Error("The diffr engine was disposed."));
      module ??= compile(engineUrl);
      const id = next++;
      const slot = pick();
      slot.busy++;

      const request: WorkerRequest = {
        id,
        request: JSON.stringify({ status, lhs, rhs, syntax: true }),
      };

      return new Promise<Diffed>((resolve, reject) => {
        pending.set(id, { slot, resolve, reject });
        module!.then(() => slot.worker.postMessage(request), fail);
      });
    },
    dispose() {
      disposed = true;

      for (const slot of [...slots]) drop(slot);
      fail(new Error("The diffr engine was disposed."));
    },
  };
}
