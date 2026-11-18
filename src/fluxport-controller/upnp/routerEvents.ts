/**
 * The router's events, as EventWatch uses them: a subscription that emits "event" for each
 * NOTIFY, renews itself, and emits "lost" when it ends without close(). The default is
 * nat-upnp's Subscription on the coordinator's router, which accepts NOTIFYs only from that
 * router's address: any other host on the LAN could otherwise make the leader read the table.
 */

import { Client } from "@runonflux/nat-upnp";

export interface RouterSubscription {
  on(event: "event", listener: () => void): unknown;
  /** It ended without close(): a renewal was refused, it lapsed unanswered, or the
   *  listener failed. Nothing is emitted after it. */
  once(event: "lost", listener: (reason: Error) => void): unknown;
  /** Stop listening and UNSUBSCRIBE; resolves whether or not the router answers. */
  close(): Promise<void>;
}

export interface RouterEvents {
  /** Listen, then subscribe. Rejects when the listener cannot start, or the router refuses,
   *  does not answer, or answers without a SID. */
  subscribe(): Promise<RouterSubscription>;
}

/** The events of the router described at `descriptionUrl`, received on `localAddress`:`port`. */
export function natUpnpRouterEvents(descriptionUrl: string, localAddress: string, port: number): RouterEvents {
  const client = new Client({ url: descriptionUrl, localAddress });
  return { subscribe: () => client.subscribe({ port }) };
}
