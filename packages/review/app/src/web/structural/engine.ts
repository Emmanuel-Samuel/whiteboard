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
  workers(): number;
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
  idleMs = 10_000,
}: {
  engineUrl: string;
  workerUrl?: string | URL;
  workers?: number;
  idleMs?: number;
}): StructuralEngine {
  const pending = new Map<number, Call>();
  const slots: Slot[] = [];
  let module: Promise<WebAssembly.Module> | undefined;
  let failure: Error | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let next = 0;
  let disposed = false;

  const settle = (id: number) => {
    const call = pending.get(id);

    if (!call) return undefined;
    pending.delete(id);
    call.slot.busy--;

    if (call.slot.retire && !call.slot.busy) drop(call.slot);

    if (!pending.size) {
      clearTimeout(idle);
      idle = setTimeout(() => {
        for (const slot of [...slots]) if (!slot.busy) drop(slot);
      }, idleMs);
    }

    return call;
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
      if ("error" in data || data.memory > MEMORY_LIMIT) slot.retire = true;
      const call = settle(data.id);

      if ("error" in data) call?.reject(new Error(data.error));
      else call?.resolve(data);
    };

    worker.onerror = (event) => {
      event.preventDefault();
      slot.retire = true;
      const error = new Error(event.message || "The diffr worker failed.");

      for (const [id, call] of pending)
        if (call.slot === slot) settle(id)?.reject(error);
      drop(slot);
    };

    return slot;
  };

  const pick = () => {
    const open = slots.filter((slot) => !slot.retire);

    const least = open.reduce<Slot | undefined>(
      (best, slot) => (!best || slot.busy < best.busy ? slot : best),
      undefined,
    );

    if (least && (least.busy < 2 || open.length >= workers)) return least;
    const slot = spawn();
    slots.push(slot);

    return slot;
  };

  return {
    workers: () => slots.length,
    diff(status, lhs, rhs) {
      if (disposed)
        return Promise.reject(new Error("The diffr engine was disposed."));

      if (failure) return Promise.reject(failure);
      clearTimeout(idle);
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
        module!.then(
          () => slot.worker.postMessage(request),
          (error: Error) => {
            failure = error;
            settle(id)?.reject(error);
            drop(slot);
          },
        );
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(idle);

      for (const slot of [...slots]) drop(slot);
      const error = new Error("The diffr engine was disposed.");

      for (const call of pending.values()) call.reject(error);
      pending.clear();
    },
  };
}
