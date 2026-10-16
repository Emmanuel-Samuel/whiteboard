const emptyModule = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

export const fakeEngineUrl = () =>
  URL.createObjectURL(new Blob([emptyModule], { type: "application/wasm" }));

export const brokenEngineUrl = () =>
  URL.createObjectURL(new Blob(["not wasm"], { type: "application/wasm" }));

const noChange = { textual: { added: 0, removed: 0 } };

/** A text diff whose fold reaches past the end of its text, so the row model throws. */
export const malformedDiff = {
  event: {
    type: "file",
    file: { rhs: { path: "src/a.ts", oid: "", mode: "" } },
    visibility: { collapsed: false, label: "" },
    diff: {
      type: "text",
      lhs: {
        text: "",
        syntax: [],
        regions: [
          {
            kind: "fold",
            id: 1,
            fold_state_id: 1,
            start: { line: 0, column: 0 },
            end: { line: 5, column: 3 },
            tags: [],
            visibility: { collapsed: false, label: "" },
            changed: [],
            children: [],
          },
        ],
      },
      stats: { ...noChange, visible: noChange.textual },
    },
  },
  lines: [
    { text: "", starts: [0] },
    { text: "", starts: [0] },
  ],
  syntax: [null, null],
};

/** A worker standing in for diffr that answers every diff with `malformedDiff`. */
export function malformedWorkerUrl() {
  const source = `onmessage = ({ data }) => {
    if ("module" in data) return;
    postMessage({ ...${JSON.stringify(malformedDiff)}, id: data.id, memory: 0 });
  };`;

  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}
