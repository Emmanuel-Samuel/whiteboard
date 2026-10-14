import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PRODUCT = path.join(import.meta.dirname, "..", "code-oss", "product.json");

const TARGETS = ["linux-x64", "linux-arm64"];

const tarballName = (version, target) => `whiteboard-remote-${version}-${target}.tar.xz`;

export async function remoteArtifacts(directory, version) {
  const files = {};

  for (const target of TARGETS) {
    const file = tarballName(version, target);
    let line;

    try {
      line = await readFile(path.join(directory, `${file}.sha256`), "utf8");
    } catch {
      throw new Error(`${directory} has no ${file}.sha256 for ${target}`);
    }

    const [sha256, name] = line.trim().split(/\s+/);

    if (name !== file)
      throw new Error(`${file}.sha256 names ${name}, not the ${target} tarball`);
    files[target] = { file, sha256 };
  }

  return files;
}

export function remotePin({ version, baseUrl, files }) {
  const pin = { version };

  for (const target of TARGETS)
    pin[target] = { url: `${baseUrl}/${files[target].file}`, sha256: files[target].sha256 };

  checkPin(pin);

  return pin;
}

function checkPin(pin) {
  const version = pin?.version ?? "";

  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("the remote pin's version is malformed");

  for (const target of TARGETS) {
    const { url = "", sha256 = "" } = pin[target] ?? {};

    if (!url.startsWith("https://") || !url.endsWith(`/${tarballName(version, target)}`))
      throw new Error(`the remote pin's ${target} URL is malformed`);

    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new Error(`the remote pin's ${target} checksum is malformed`);
  }
}

export function writePin(pin, productPath = PRODUCT) {
  checkPin(pin);
  const product = JSON.parse(readFileSync(productPath, "utf8"));
  product.whiteboardRemote = pin;
  writeFileSync(productPath, `${JSON.stringify(product, null, "\t")}\n`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      product: { type: "string", default: PRODUCT },
      pinned: { type: "string" },
    },
  });

  if (values.pinned !== undefined) {
    let pin;

    try {
      pin = JSON.parse(values.pinned);
    } catch {
      throw new Error("the remote pin is not JSON");
    }

    writePin(pin, values.product);

    return;
  }

  if (positionals.length !== 3) {
    console.error(
      "usage: stamp-remote-artifacts.mjs <artifacts-dir> <version> <base-url>\n" +
        "       stamp-remote-artifacts.mjs --pinned <json> [--product <path>]",
    );
    process.exit(2);
  }

  const [directory, version, baseUrl] = positionals;
  const files = await remoteArtifacts(directory, version);
  console.log(JSON.stringify(remotePin({ version, baseUrl, files })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
