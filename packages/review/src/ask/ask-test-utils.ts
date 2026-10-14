import {
  type ClientConnection,
  agent,
  methods,
} from "@agentclientprotocol/sdk";

import type { AskAgentLauncher } from "./agents.js";

/** An ACP agent that ends every turn at once; counts launches and stops. */
export function idleAskAgent() {
  const counts = { launches: 0, stopped: 0 };

  const fake = agent({ name: "fake" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: "session" }))
    .onRequest(methods.agent.session.load, () => ({}))
    .onRequest(methods.agent.session.prompt, () => ({
      stopReason: "end_turn" as const,
    }));

  const launch: AskAgentLauncher = async () => {
    let connection: ClientConnection | undefined;
    counts.launches++;

    return {
      connect: (client) => (connection = client.connect(fake)),
      diagnostics: () => "",
      stop: () => {
        counts.stopped++;
        connection?.close();
      },
    };
  };

  return { launch, counts };
}
