// The workerd suite's Worker: the library's Durable Object classes, plus a bare store whose storage
// the tests drive directly through `runInDurableObject`.

import { DurableObject } from "cloudflare:workers";

export { StudioAccountState } from "../../src/account-state.js";
export { StudioFacetHost } from "../../src/testing.js";

/** A store with nothing of its own: tests migrate and use its storage in place. */
export class KitTestStore extends DurableObject {}

export default {
  async fetch(): Promise<Response> {
    return new Response("studio-kit test worker");
  },
};
