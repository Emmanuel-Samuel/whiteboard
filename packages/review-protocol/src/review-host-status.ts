import type { ReviewGatewayHostState } from "./contracts.js";

export interface ReviewHostStatus {
  /** Short words for a chip or a list row, without the host name. */
  status: string;
  /** The same with the host name, for a heading. */
  label: string;
  sentence: string;
  /** What helps: none while the host is busy or online. */
  action?: "retry" | "install" | "settings";
  busy?: true;
}

type Wording = Pick<ReviewHostStatus, "action" | "busy"> & {
  status: string;
  label(alias: string): string;
};

const OFFLINE: Wording = {
  status: "offline",
  label: (alias) => `${alias} offline`,
  action: "retry",
};

const UNUSABLE: Wording = {
  status: "can't be used",
  label: (alias) => `${alias} can't be used`,
  action: "settings",
};

const STATUS: Record<ReviewGatewayHostState["state"], Wording> = {
  online: { status: "online", label: (alias) => alias },
  connecting: {
    status: "connecting",
    label: (alias) => `Connecting to ${alias}…`,
    busy: true,
  },
  installing: {
    status: "installing",
    label: (alias) => `Installing on ${alias}…`,
    busy: true,
  },
  offline: OFFLINE,
  unreachable: OFFLINE,
  incompatible: {
    status: "needs an update",
    label: (alias) => `${alias} needs an update`,
    action: "install",
  },
  "not-installed": {
    status: "not installed",
    label: (alias) => `Whiteboard not installed on ${alias}`,
    action: "install",
  },
  "auth-failed": {
    status: "can't sign in",
    label: (alias) => `Can't sign in to ${alias}`,
    action: "settings",
  },
  unsupported: UNUSABLE,
  duplicate: UNUSABLE,
};

/** One wording and one next step per host state, shared by every surface. */
export function reviewHostStatus(
  host: Pick<ReviewGatewayHostState, "alias" | "state" | "detail">,
): ReviewHostStatus {
  const { label, ...rest } = STATUS[host.state];
  const words = label(host.alias);

  return {
    ...rest,
    label: words,
    sentence: host.detail ?? (words.endsWith("…") ? words : `${words}.`),
  };
}
