import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { sourceAliases } from "../test-config";
import { webStylexOptions } from "./stylex-options";

const require = createRequire(import.meta.url);

const decodeNamedCharacterReferenceIndex = path.join(
  path.dirname(require.resolve("decode-named-character-reference")),
  "index.js",
);

const outDir = path.resolve(__dirname, "../dist/canvas");

export default defineConfig({
  root: __dirname,
  plugins: [
    stylex.vite(webStylexOptions),
    {
      name: "katex-woff2-only",
      enforce: "pre",
      transform(source, moduleId) {
        if (!/[/\\]katex[/\\]dist[/\\]katex\.css$/.test(moduleId)) return;

        return {
          code: source.replaceAll(
            /, url\([^)]+\) format\("(?:woff|truetype)"\)/g,
            "",
          ),
          map: null,
        };
      },
    },
    react(),
    {
      name: "copy-canvas-companions",
      closeBundle() {
        copyFileSync(
          path.join(
            path.dirname(require.resolve("@mr_mint/elkjs-libavoid")),
            "libavoid.wasm",
          ),
          path.join(outDir, "libavoid.wasm"),
        );
        copyFileSync(
          path.resolve(__dirname, "src/web-entry.d.ts"),
          path.join(outDir, "canvas.d.ts"),
        );
      },
    },
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      ...sourceAliases,
      "decode-named-character-reference": decodeNamedCharacterReferenceIndex,
    },
  },
  base: "./",
  build: {
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    copyPublicDir: false,
    emptyOutDir: true,
    manifest: true,
    outDir,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        canvas: path.resolve(__dirname, "src/web-entry.tsx"),
      },
      output: {
        entryFileNames: "canvas.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
