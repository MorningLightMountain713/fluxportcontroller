/**
 * Flux deterministic node list — the public API this package reads to learn, for
 * this node: its public IP (to filter the list), its prior confirmed port (sticky
 * reuse) and its `confirmed_height` (the conflict priority — globally known, stable
 * across restarts, no local state). Standalone fetchers so the composition root can
 * inject them and the whole flow stays testable over HTTP-free seams.
 */

import axios from "axios";

import { logController } from "./log";

const logger = logController.getLogger();

const AXIOS_TIMEOUT = 3000;
const DEFAULT_ADDRESS_APIS = [
  "https://ifconfig.me",
  "https://checkip.amazonaws.com",
  "https://api.ipify.org"
];

export interface OutPoint {
  txhash: string;
  outidx: string;
}

/** What we need from the deterministic node list for this node. */
export interface NodeInfo {
  /** Previously-confirmed port for this node, if any (sticky reuse). */
  priorPort: number | null;
  /** Conflict priority — lower wins. Use confirmed_height; absent ⇒ +Infinity. */
  priority: number;
}

export const NODE_LIST_ADDRESS_APIS = DEFAULT_ADDRESS_APIS;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchPublicIp(
  outPoint: OutPoint,
  addressApis: string[] = DEFAULT_ADDRESS_APIS
): Promise<string> {
  if (outPoint.txhash === "testtx") return "10.10.10.10";

  const apis = [...addressApis];
  for (;;) {
    const api = apis.shift()!;
    apis.push(api);
    try {
      const { data } = await axios.get(api, { timeout: AXIOS_TIMEOUT });
      const ip = String(data).trim();
      if (ip) return ip;
    } catch {
      logger.warn(`Error getting public IP from ${api}, switching...`);
    }
  }
}

export async function fetchNodeInfo(
  publicIp: string,
  outPoint: OutPoint
): Promise<NodeInfo> {
  if (outPoint.txhash === "testtx") {
    return { priorPort: null, priority: Number.MAX_SAFE_INTEGER };
  }

  const url = `https://api.runonflux.io/daemon/viewdeterministiczelnodelist?filter=${publicIp}`;
  let list: any[] | null = null;
  while (!list) {
    try {
      const { data } = await axios.get(url, { timeout: AXIOS_TIMEOUT });
      if (data?.status === "success") list = data.data;
    } catch {
      logger.warn(`Error fetching deterministic list for ${publicIp}, retrying`);
    }
    if (!list) await sleep(1000);
  }

  const node = list.find(
    (n) => n.txhash === outPoint.txhash && n.outidx === outPoint.outidx
  );
  if (!node) {
    // not yet confirmed: lowest possible priority so established nodes win
    return { priorPort: null, priority: Number.MAX_SAFE_INTEGER };
  }

  const [, portStr] = String(node.ip).split(":");
  const priorPort = +portStr || 16127;
  const priority = Number(node.confirmed_height) || Number.MAX_SAFE_INTEGER;
  return { priorPort, priority };
}
