// Adapted from diffr (MIT) web/src/worker.ts at 62575763d.
import { type Diffed, parseDiffed } from "./diffed";
import { Differ, initSync } from "./engine/diffr_web.js";

export type WorkerRequest =
  | { module: WebAssembly.Module }
  | { id: number; request: string };

export type WorkerResponse =
  | ({ id: number; memory: number } & Diffed)
  | { id: number; error: string; memory: number };

let differ: Differ | undefined;

let memory: WebAssembly.Memory | undefined;

const usedMemory = () => memory?.buffer.byteLength ?? 0;

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  if ("module" in data) {
    memory = initSync({ module: data.module }).memory;
    differ = new Differ();

    return;
  }

  let reply: WorkerResponse;

  try {
    reply = {
      id: data.id,
      ...parseDiffed(differ!.diff(data.request)),
      memory: usedMemory(),
    };
  } catch (error) {
    reply = {
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
      memory: usedMemory(),
    };
  }

  const transfer =
    "lines" in reply
      ? [
          ...reply.syntax.flatMap((s) =>
            s ? [s.spans.buffer, s.index.buffer] : [],
          ),
          ...reply.lines.map((l) => l.starts.buffer),
        ]
      : [];

  self.postMessage(reply, { transfer });
};
