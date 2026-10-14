/** Hosts in Docker containers: the image, `up`, `install`, and the sealed network. */
import { createHash, randomBytes } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";

import { buildDevRemoteTarball } from "../../build-remote-tarball.mjs";
import { remoteDevInstall } from "../../remote-dev-install.mjs";

import { addOnce, docker, exec, run, sleep } from "./exec.mjs";
import { hostOf } from "./run-state.mjs";
import { waitForSsh } from "./ssh.mjs";

const imageDir = path.join(import.meta.dirname, "image");

const TOOLCHAIN_IMAGES = {
  rust: "rust:1.98-bookworm",
  swift: "swift:6.4-noble",
  dotnet: "mcr.microsoft.com/dotnet/sdk:10.0-noble",
};

/** Tags are per run, so removing one run's tag never touches another run's containers. */
async function buildImage(
  runState,
  { platform, image, node, shell, toolchain },
) {
  const hash = createHash("sha256");

  for (const file of ["Dockerfile", "setup.sh", "start.sh"])
    hash.update(await readFile(path.join(imageDir, file)));

  hash.update(JSON.stringify([platform, image, node, shell, toolchain]));

  const tag = `wb-test-${runState.id}-image:${hash.digest("hex").slice(0, 12)}`;

  addOnce(runState.state.images, tag);
  await runState.save();
  await docker(
    "build",
    "-q",
    ...(platform ? ["--platform", platform] : []),
    "--build-arg",
    `BASE=${image}`,
    "--build-arg",
    `NODE=${node}`,
    "--build-arg",
    `LOGIN_SHELL=${shell}`,
    "--build-arg",
    `TOOLCHAIN=${toolchain}`,
    "-t",
    tag,
    imageDir,
  );

  return tag;
}

/** Runs one root command in a throwaway container with NET_ADMIN, in `network`'s namespace. */
const netAdmin = (runState, image, network, script) =>
  docker(
    "run",
    "--rm",
    "--name",
    `wb-test-${runState.id}-net-${randomBytes(3).toString("hex")}`,
    "--label",
    `wb-test-run=${runState.id}`,
    "--network",
    network,
    "--cap-add",
    "NET_ADMIN",
    "--entrypoint",
    "sh",
    image,
    "-c",
    script,
  );

async function seal(runState, host) {
  await netAdmin(
    runState,
    host.image,
    `container:${host.container}`,
    "ip route del default",
  );

  const reached = await docker(
    "exec",
    host.container,
    "curl",
    "-sS",
    "-m",
    "5",
    "-o",
    "/dev/null",
    "https://example.com",
  ).then(
    () => true,
    () => false,
  );

  if (reached) throw new Error(`${host.alias} still reaches the internet`);
}

function parsePort(value) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`--port must be an integer from 1024 to 65535`);

  return port;
}

export async function up(runState, name, options) {
  const { state } = runState;

  if (state.hosts[name]) throw new Error(`host ${name} already exists`);

  const jump = options.jump && hostOf(runState, options.jump);
  const auth = options.auth ?? "key";
  const port = options.port && parsePort(options.port);

  if (!["key", "password"].includes(auth)) throw new Error(`--auth ${auth}`);

  if (jump && port) throw new Error("--port and --jump cannot be combined");

  const toolchain = options.toolchain ?? "none";

  if (toolchain !== "none" && !TOOLCHAIN_IMAGES[toolchain])
    throw new Error(`--toolchain ${toolchain}: expected rust, swift or dotnet`);

  const image = await buildImage(runState, {
    platform: options.platform,
    image: options.image ?? TOOLCHAIN_IMAGES[toolchain] ?? "ubuntu:22.04",
    node: options.node ?? "24",
    shell: options.shell ?? "bash",
    toolchain,
  });

  const network = `wb-test-${runState.id}`;

  if (!state.networks.includes(network)) {
    state.networks.push(network);
    await runState.save();
    await docker(
      "network",
      "create",
      "--label",
      `wb-test-run=${runState.id}`,
      network,
    );
  }

  const alias = `wb-test-${name}`;
  const container = `wb-test-${runState.id}-${name}`;
  const host = { kind: "docker", alias, container, image, user: "dev" };

  state.hosts[name] = host;
  addOnce(state.containers, container);
  await runState.save();

  const env = {
    WB_PUBLIC_KEY:
      auth === "key"
        ? await readFile(`${runState.dir}/id_ed25519.pub`, "utf8")
        : "",
    WB_PASSWORD:
      auth === "password"
        ? await readFile(`${runState.dir}/password`, "utf8")
        : "",
    WB_BANNER: options.banner ? "1" : "0",
    WB_FORWARDING: options["no-forwarding"] ? "0" : "1",
  };

  // Values pass through the environment, so a password never shows in `ps`.
  await run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--hostname",
      alias,
      "--network",
      network,
      "--network-alias",
      alias,
      "--label",
      `wb-test-run=${runState.id}`,
      ...(options.platform ? ["--platform", options.platform] : []),
      ...(jump ? [] : ["-p", `127.0.0.1:${port || ""}:22`]),
      ...Object.keys(env).flatMap((key) => ["-e", key]),
      image,
    ],
    { env: { ...process.env, ...env } },
  );

  if (options.sealed) {
    host.sealed = true;
    await runState.save();
    await seal(runState, host);
  }

  const delay = Number(options["delay-ms"] ?? 0);

  if (delay) {
    // netem only delays egress: the container's for replies, and its host-side veth for requests.
    const link = await docker(
      "exec",
      container,
      "cat",
      "/sys/class/net/eth0/iflink",
    );

    await netAdmin(
      runState,
      image,
      `container:${container}`,
      `tc qdisc add dev eth0 root netem delay ${delay}ms`,
    );
    await netAdmin(
      runState,
      image,
      "host",
      `for d in /sys/class/net/*; do [ "$(cat $d/ifindex 2>/dev/null)" = ${link} ] && exec tc qdisc add dev \${d##*/} root netem delay ${delay}ms; done; exit 1`,
    );
  }

  if (jump)
    Object.assign(host, { hostName: alias, port: 22, jump: jump.alias });
  else {
    const published = await docker("port", container, "22/tcp");

    Object.assign(host, {
      hostName: "127.0.0.1",
      port: Number(published.split("\n")[0].split(":").pop()),
    });
  }

  await runState.save();

  // sshd logs to stderr, which `docker logs` keeps as stderr.
  const sshdLog = () =>
    exec("docker", ["logs", container]).then(
      ({ stderr }) => stderr,
      () => "",
    );

  for (let i = 0; !(await sshdLog()).includes("Server listening"); i++) {
    if (i > 40) throw new Error(`sshd did not start in ${container}`);

    await sleep(250);
  }

  const knownAs =
    host.port === 22 ? host.hostName : `[${host.hostName}]:${host.port}`;

  const known = await run("ssh-keygen", [
    "-F",
    knownAs,
    "-f",
    `${runState.dir}/known_hosts`,
  ]).then(
    () => true,
    () => false,
  );

  // A host recreated on a known port has a new key; keep the old entry so ssh refuses it, as a user's would.
  if (known)
    console.error(`${alias}: known_hosts keeps the earlier key for ${knownAs}`);

  if (auth === "key")
    await waitForSsh(
      runState,
      host,
      15,
      "true",
      known
        ? [
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "LogLevel=ERROR",
          ]
        : [],
    );

  console.log(alias);
}

export function containerOf(runState, name) {
  const host = hostOf(runState, name);

  if (host.kind !== "docker") throw new Error(`${name} is not a container`);

  return host;
}

export async function packTarball(out, { version, arch = "x64" } = {}) {
  const built = await buildDevRemoteTarball({
    target: `linux-${arch}`,
    version,
    stdio: ["ignore", process.stderr, process.stderr],
  });

  await copyFile(built.file, out);

  return { ...built, file: out };
}

/** Installs this checkout's tarball as a hand install would, with a `whiteboard` on the default PATH. */
export async function install(runState, name, { version, commit } = {}) {
  const host = containerOf(runState, name);

  console.log(
    await remoteDevInstall(host.alias, {
      sshConfig: `${runState.dir}/ssh_config`,
      version,
      commit,
      stdio: ["ignore", process.stderr, process.stderr],
    }),
  );
  await docker(
    "exec",
    host.container,
    "ln",
    "-sf",
    `/home/${host.user}/.local/bin/whiteboard`,
    "/usr/local/bin/whiteboard",
  );
}
