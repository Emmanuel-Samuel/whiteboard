# diffr engine

wasm-bindgen output of diffr's `crates/diffr-web`, built at diffr commit
`62575763da005cb376ca63851a3cfbf0ce30fef1` (branch `mb/diffr-web`).

```sh
rustup target add wasm32-unknown-unknown
rustup component add llvm-tools
cargo install wasm-bindgen-cli --version 0.2.129
# clang must be on PATH (tree-sitter grammars compile C)
cargo xtask build-web
gzip -9 -k web/src/wasm/diffr_web_bg.wasm
```

Copy `diffr_web.js`, `diffr_web.d.ts` and `diffr_web_bg.wasm.d.ts` here. The engine
itself, `diffr_web_bg.wasm.gz` (6,872,161 bytes; 64 MB unpacked), is gitignored: the host
serves it and passes its URL as `structural.engineUrl`. Place it here to run the opt-in
engine tests.
