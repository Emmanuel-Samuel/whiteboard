/* tslint:disable */
/* eslint-disable */

export class Differ {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Diff one changed file. `request` is JSON:
     * `{"status": "modified", "lhs": {"path", "text"}, "rhs": {"path", "text"}}`,
     * with `lhs` absent for an added file and `rhs` for a deleted one, and
     * an optional `"syntax": true` for highlight spans. Returns JSON
     * `{"entry": <manifest entry>, "event": <file record>}`.
     */
    diff(request: string): string;
    /**
     * A differ for `config`, the text of a `config.toml`, or the bundled
     * defaults when it is absent.
     */
    constructor(config?: string | null);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_differ_free: (a: number, b: number) => void;
    readonly differ_diff: (a: number, b: number, c: number) => [number, number, number, number];
    readonly differ_new: (a: number, b: number) => [number, number, number];
    readonly memcmp: (a: number, b: number, c: number) => number;
    readonly iswspace: (a: number) => number;
    readonly iswdigit: (a: number) => number;
    readonly iswalpha: (a: number) => number;
    readonly malloc: (a: number) => number;
    readonly free: (a: number) => void;
    readonly memcpy: (a: number, b: number, c: number) => number;
    readonly iswalnum: (a: number) => number;
    readonly strlen: (a: number) => number;
    readonly calloc: (a: number, b: number) => number;
    readonly realloc: (a: number, b: number) => number;
    readonly abort: () => void;
    readonly strcmp: (a: number, b: number) => number;
    readonly strncpy: (a: number, b: number, c: number) => number;
    readonly iswlower: (a: number) => number;
    readonly iswupper: (a: number) => number;
    readonly memmove: (a: number, b: number, c: number) => number;
    readonly memchr: (a: number, b: number, c: number) => number;
    readonly memset: (a: number, b: number, c: number) => number;
    readonly iswxdigit: (a: number) => number;
    readonly towupper: (a: number) => number;
    readonly cabi_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly cabi_realloc_wit_bindgen_0_62_0: (a: number, b: number, c: number, d: number) => number;
    readonly strncmp: (a: number, b: number, c: number) => number;
    readonly strchr: (a: number, b: number) => number;
    readonly strncat: (a: number, b: number, c: number) => number;
    readonly iswblank: (a: number) => number;
    readonly iswpunct: (a: number) => number;
    readonly towlower: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
