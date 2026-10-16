// Adapted from diffr (MIT) web/src/worker.ts at 62575763d.
import { type Lines, lineCount, splitLines } from "./lines";
import { type Syntax, packSyntax } from "./syntax";
import { type FileEvent, type Region, eventSchema } from "./wire";

export interface Diffed {
  event: FileEvent;
  lines: [Lines, Lines];
  syntax: [Syntax | undefined, Syntax | undefined];
}

function trimUnpaired(sides: [Region[], Region[]]) {
  const leaves = sides.map((regions) => {
    const all: Region[] = [];

    const walk = (list: Region[]) =>
      list.forEach((r) => (r.kind === "leaf" ? all.push(r) : walk(r.children)));

    walk(regions);

    return all;
  });

  const alignments = leaves.map(
    (list) =>
      new Set(list.map((r) => (r.kind === "leaf" ? r.alignment_id : -1))),
  );

  leaves.forEach((list, side) => {
    for (const leaf of list)
      if (
        leaf.kind === "leaf" &&
        leaf.changed.length > 1 &&
        !alignments[side ? 0 : 1]!.has(leaf.alignment_id)
      )
        leaf.changed = leaf.changed.slice(0, 1);
  });
}

export function parseDiffed(output: string): Diffed {
  const event = eventSchema.parse(JSON.parse(output).event);

  if (event.type !== "file")
    throw new Error(`diffr sent a ${event.type} event for a file`);
  const lines: Diffed["lines"] = [splitLines(""), splitLines("")];
  const syntax: Diffed["syntax"] = [undefined, undefined];
  const result = event.diff;

  if (result?.type === "text") {
    trimUnpaired([result.lhs?.regions ?? [], result.rhs?.regions ?? []]);
    [result.lhs, result.rhs].forEach((side, i) => {
      if (!side) return;
      lines[i] = splitLines(side.text);

      if (side.syntax.length)
        syntax[i] = packSyntax(side.syntax, lineCount(lines[i]!));
      side.text = "";
      side.syntax = [];
    });
  }

  return { event, lines, syntax };
}
