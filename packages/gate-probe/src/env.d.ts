// `ctx.exports` and the Durable Object namespaces, from this Worker's main module.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "StudioAccountState" | "ProbeNotesStore" | "ProbeGatekeeper";
  }
}

// Text modules (wrangler `rules`): the app page and the agent-facing declarations.
declare module "*.txt" {
  const value: string;
  export default value;
}
