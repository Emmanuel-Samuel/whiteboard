import path from "node:path";

import type { UserOptions } from "@stylexjs/unplugin";

type Targets = Record<string, number>;

const chrome = { chrome: 140 << 16 };

// One option set for the production build and Vitest, so a style hashes to the
// same class name in both. `dev: false` also keeps StyleX from adding debug
// class names and `data-style-src` attributes.
const optionsFor = (targets: Targets) =>
  ({
    dev: false,
    // Unsupported properties (the `background` and `border` shorthands) are
    // otherwise dropped without a word.
    propertyValidationMode: "throw",
    unstable_moduleResolution: { type: "commonJS", rootDir: __dirname },
    // The `@canvas/*` path, so modules in src/ subfolders can import tokens and
    // markers without a relative parent path.
    aliases: { "@canvas/*": [path.join(__dirname, "src/*")] },
    lightningcssOptions: { targets, minify: true },
  }) satisfies Partial<UserOptions>;

// Chromium 140 (Electron 42) is the desktop runtime floor: nothing to lower.
export const stylexOptions = optionsFor(chrome);

export const webStylexOptions = optionsFor({
  ...chrome,
  safari: 17 << 16,
  firefox: 128 << 16,
});
