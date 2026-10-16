import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import stylex from "@stylexjs/unplugin";
import react from "@vitejs/plugin-react";
import { type Rollup, defineConfig } from "vite";

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
      name: "stable-canvas-stylesheet",
      enforce: "post",
      generateBundle(_options, bundle) {
        const [css, ...extra] = Object.values(bundle).filter(
          (output): output is Rollup.OutputAsset =>
            output.type === "asset" && output.fileName.endsWith(".css"),
        );

        if (!css || extra.length)
          throw new Error("The web canvas build must emit one stylesheet.");

        const fileName = "canvas.css";

        delete bundle[css.fileName];
        this.emitFile({ type: "asset", fileName, source: css.source });

        for (const output of Object.values(bundle))
          if (output.type === "chunk") {
            const imported = output.viteMetadata?.importedCss;

            if (imported?.delete(css.fileName)) imported.add(fileName);
          }
      },
    },
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
  worker: { format: "es" },
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
        assetFileNames: ({ names }) =>
          names.some((name) => name.endsWith(".css"))
            ? "[name]-[hash][extname]"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
