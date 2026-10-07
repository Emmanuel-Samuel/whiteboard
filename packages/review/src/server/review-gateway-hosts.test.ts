import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { readReviewPackageVersion } from "@review/package-paths.js";
import { Agent } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createGatewayHosts } from "./review-gateway-hosts.js";
import {
  startFake,
  startRemote,
  stopAll,
} from "./review-gateway-test-utils.js";
import { readBody, send } from "./review-gateway-transport.js";

const version = readReviewPackageVersion(import.meta.url);

let root: string;

const closes: (() => void)[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-gateway-hosts-"));
  vi.stubEnv("DEV_REVIEW_HOME", root);
  vi.stubEnv("DEV_FAST_REVIEW_TELEMETRY_DISABLED", "1");
});

afterEach(async () => {
  for (const close of closes.splice(0)) close();
  await stopAll();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function hosts(localVersion = version) {
  const created = createGatewayHosts({ version: localVersion });
  closes.push(() => created.close());

  return created;
}

it("never contacts a host that arrives with a problem", async () => {
  const fake = await startFake({ version });
  const answering = await startFake({ version });
  const gateway = hosts();

  gateway.set([
    {
      alias: "devbox",
      endpoint: fake.endpoint,
      problem: { state: "auth-failed", detail: "Permission denied." },
    },
    { alias: "later" },
    { alias: "up", endpoint: answering.endpoint },
  ]);
  await expect.poll(() => gateway.states()[2]?.state).toBe("online");

  expect(gateway.states().slice(0, 2)).toEqual([
    { alias: "devbox", state: "auth-failed", detail: "Permission denied." },
    { alias: "later", state: "connecting", detail: expect.any(String) },
  ]);
  expect(fake.requests).toEqual([]);
});

it("refuses a host on another version, naming both versions, with the install command beside the detail", async () => {
  const remote = await startRemote(path.join(root, "a"));
  const gateway = hosts("0.0.0-other");

  gateway.set([{ alias: "devbox", endpoint: remote.endpoint }]);

  await expect.poll(() => gateway.states()[0]?.state).toBe("incompatible");
  const [state] = gateway.states();
  expect(state?.serverId).toBe((await remote.health()).serverId);
  expect(state?.detail).toContain(version);
  expect(state?.detail).toContain("0.0.0-other");
  expect(state?.detail).toContain("Install Whiteboard 0.0.0-other on devbox.");
  expect(state?.detail).not.toContain("npm install");
  expect(state?.installCommand).toBe(
    "npm install -g @dev.fast/whiteboard@0.0.0-other",
  );
  expect(gateway.online()).toEqual([]);
});

it("refuses a host whose version is not a version, without repeating it", async () => {
  const fake = await startFake({ version: "x npm install -g evil" });
  const gateway = hosts("0.1.6");

  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);

  await expect.poll(() => gateway.states()[0]?.state).toBe("incompatible");
  const [state] = gateway.states();
  expect(state?.detail).toBe("devbox reports an invalid version.");
  expect(state?.installCommand).toBe(
    "npm install -g @dev.fast/whiteboard@0.1.6",
  );
  expect(gateway.online()).toEqual([]);
});

it("names this machine's install command for a host without Whiteboard", () => {
  const gateway = hosts("0.1.6");

  gateway.set([
    {
      alias: "devbox",
      problem: {
        state: "not-installed",
        detail: "Whiteboard is not installed on devbox.",
      },
    },
    {
      alias: "other",
      problem: { state: "auth-failed", detail: "Permission denied." },
    },
  ]);

  expect(gateway.states()).toEqual([
    {
      alias: "devbox",
      state: "not-installed",
      detail: "Whiteboard is not installed on devbox.",
      installCommand: "npm install -g @dev.fast/whiteboard@0.1.6",
    },
    { alias: "other", state: "auth-failed", detail: "Permission denied." },
  ]);
});

it("refuses a host whose version could not be read", async () => {
  const fake = await startFake({ version: "unknown" });
  const gateway = hosts("unknown");

  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);

  await expect.poll(() => gateway.states()[0]?.state).toBe("incompatible");
});

it("retries an offline host until it answers", async () => {
  const fake = await startFake({ version });
  await fake.stop();
  const gateway = hosts();

  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);
  await expect.poll(() => gateway.states()[0]?.state).toBe("offline");

  await startFake({ version }, fake.port);
  await expect
    .poll(() => gateway.states()[0]?.state, { timeout: 5_000 })
    .toBe("online");
});

it("uses neither of two machines with a copied id, until one leaves the setting", async () => {
  const first = await startRemote(path.join(root, "a"));
  await first.stop();
  await cp(path.join(root, "a"), path.join(root, "c"), { recursive: true });
  const a = await startRemote(path.join(root, "a"));
  const c = await startRemote(path.join(root, "c"));
  const { serverId } = await a.health();
  const gateway = hosts();

  gateway.set([
    { alias: "wb-a", endpoint: a.endpoint },
    { alias: "wb-c", endpoint: c.endpoint },
  ]);

  await expect
    .poll(() => gateway.states().map((host) => host.state))
    .toEqual(["duplicate", "duplicate"]);
  expect(gateway.states()[0]?.detail).toContain("wb-a, wb-c");
  expect(gateway.states()[0]?.detail).toContain("whiteboard server reset-id");
  expect(gateway.serving(serverId)).toBeUndefined();
  expect(gateway.online()).toEqual([]);

  await c.stop();
  gateway.set([{ alias: "wb-a", endpoint: a.endpoint }]);
  expect(gateway.states()).toEqual([
    { alias: "wb-a", serverId, state: "online" },
  ]);
  expect(gateway.serving(serverId)?.alias).toBe("wb-a");
});

it("leaves a host in backoff alone when only another host changes, and checks it at once when its own entry does", async () => {
  let failing = true;
  let checks = 0;

  const fake = await startFake({
    version,
    handle(request, response) {
      if (request.url !== "/health") return false;
      checks += 1;

      if (!failing) return false;
      response.statusCode = 500;
      response.end();

      return true;
    },
  });

  const gateway = hosts();

  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);
  await expect
    .poll(() => checks, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(4);
  expect(gateway.states()[0]?.state).toBe("offline");
  const before = checks;

  failing = false;
  gateway.set([
    { alias: "devbox", endpoint: fake.endpoint },
    { alias: "other" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(checks).toBe(before);
  expect(gateway.states()[0]?.state).toBe("offline");

  gateway.set([{ alias: "devbox" }, { alias: "other" }]);
  gateway.set([
    { alias: "devbox", endpoint: fake.endpoint },
    { alias: "other" },
  ]);

  await expect
    .poll(() => gateway.states()[0]?.state, { timeout: 1_000 })
    .toBe("online");
}, 20_000);

async function listen(answer: (socket: net.Socket, request: number) => void) {
  let requests = 0;

  const server = net.createServer((socket) => {
    let received = "";

    socket.on("data", (chunk) => {
      received += chunk.toString();

      if (!received.endsWith("\r\n\r\nhi")) return;
      received = "";
      requests += 1;
      answer(socket, requests);
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closes.push(() => server.close());
  const dispatcher = new Agent();
  closes.push(() => dispatcher.destroy());

  // SAFETY: a TCP listener's address() is an AddressInfo.
  const { port } = server.address() as AddressInfo;

  const post = async () => {
    const response = await send(
      {
        alias: "devbox",
        endpoint: { url: `http://127.0.0.1:${port}`, token: "" },
        dispatcher,
      },
      { method: "POST", path: "/ask", body: Buffer.from("hi") },
    );

    return (await readBody(response.body, 64)).toString();
  };

  return { post, requests: () => requests };
}

it("sends a request again when the host closed the kept-alive socket it reused", async () => {
  const host = await listen((socket, request) => {
    if (request === 2) socket.destroy();
    else socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  });

  expect(await host.post()).toBe("ok");
  // Wait for undici to free the connection, so the next request reuses it.
  await new Promise((resolve) => setImmediate(resolve));
  expect(await host.post()).toBe("ok");
  expect(host.requests()).toBe(3);
});

it("does not send a request with a body again when a new connection closed", async () => {
  const host = await listen((socket) => socket.destroy());

  await expect(host.post()).rejects.toMatchObject({ code: "UND_ERR_SOCKET" });
  expect(host.requests()).toBe(1);
});

it("a restarted server is offline until Desktop attaches again, then online with the new token", async () => {
  const stateDir = path.join(root, "a");
  const a = await startRemote(stateDir);
  const port = Number(new URL(a.endpoint.url).port);
  const restarted: string[] = [];

  const gateway = createGatewayHosts({
    version,
    restarted: (alias) => restarted.push(alias),
  });

  closes.push(() => gateway.close());

  gateway.set([
    { alias: "wb-a1", endpoint: a.endpoint },
    { alias: "wb-a2", endpoint: a.endpoint },
  ]);
  const { serverId } = await a.health();
  await expect
    .poll(() => gateway.states().map((host) => host.state))
    .toEqual(["online", "online"]);

  await a.stop();
  const b = await startRemote(stateDir, port);
  gateway.failed(gateway.serving(serverId)!, "test");

  await expect
    .poll(() => gateway.states().map((host) => [host.state, host.detail]))
    .toEqual([
      ["offline", "wb-a1 restarted; attaching again."],
      ["offline", "wb-a2 restarted; attaching again."],
    ]);
  expect(restarted).toEqual(["wb-a1", "wb-a2"]);

  gateway.set([
    { alias: "wb-a1", endpoint: b.endpoint },
    { alias: "wb-a2", endpoint: b.endpoint },
  ]);
  await expect
    .poll(() => gateway.states().map((host) => host.state))
    .toEqual(["online", "online"]);
  expect(restarted).toHaveLength(2);
  expect(gateway.serving(serverId)?.alias).toBe("wb-a1");
}, 20_000);

it("a 401 from a host asks Desktop once to attach again", async () => {
  const fake = await startFake({
    version,
    handle: (request, response) => {
      if (request.url === "/health") return false;
      response.statusCode = 401;
      response.end();

      return true;
    },
  });

  const restarted: string[] = [];

  const gateway = createGatewayHosts({
    version,
    restarted: (alias) => restarted.push(alias),
  });

  closes.push(() => gateway.close());

  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);
  await expect.poll(() => gateway.states()[0]?.state).toBe("online");
  const [remote] = gateway.online();

  for (let i = 0; i < 2; i++)
    await (
      await send(remote!, { method: "GET", path: "/reviews-api" })
    ).body.dump();

  expect(gateway.states()[0]).toMatchObject({
    state: "offline",
    detail: "devbox restarted; attaching again.",
  });
  expect(restarted).toEqual(["devbox"]);
});

it("a server that stops answering /health is attached again after three timeouts in a row", async () => {
  let hanging = false;

  const fake = await startFake({
    version,
    handle: (request) => hanging && request.url === "/health",
  });

  const restarted: string[] = [];

  const gateway = createGatewayHosts({
    version,
    restarted: (alias) => restarted.push(alias),
  });

  closes.push(() => gateway.close());
  gateway.set([{ alias: "devbox", endpoint: fake.endpoint }]);
  await expect.poll(() => gateway.states()[0]?.state).toBe("online");

  hanging = true;
  gateway.failed(gateway.online()[0]!, "test");

  await expect
    .poll(() => gateway.states()[0]?.detail, { timeout: 5_000 })
    .toBe("devbox is offline: it did not answer within 3 seconds.");
  expect(restarted).toEqual([]);

  await expect.poll(() => restarted, { timeout: 20_000 }).toEqual(["devbox"]);
  expect(gateway.states()[0]).toMatchObject({
    state: "offline",
    detail:
      "devbox is offline: it did not answer within 3 seconds, 3 times in a row; attaching again.",
  });
}, 30_000);

it("a server gone from behind a working forward asks Desktop to attach again", async () => {
  const a = await startRemote(path.join(root, "a"));
  const restarted: string[] = [];

  const gateway = createGatewayHosts({
    version,
    restarted: (alias) => restarted.push(alias),
  });

  closes.push(() => gateway.close());
  gateway.set([{ alias: "wb-a", endpoint: a.endpoint }]);
  await expect.poll(() => gateway.states()[0]?.state).toBe("online");

  await a.stop();
  gateway.failed(gateway.online()[0]!, "test");

  await expect.poll(() => restarted).toEqual(["wb-a"]);
  expect(gateway.states()[0]).toMatchObject({
    state: "offline",
    detail: "wb-a is offline: it refused the connection; attaching again.",
  });
});
