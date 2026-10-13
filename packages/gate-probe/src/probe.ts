/**
 * The Probe vendor and its auto-provisioned accounts.
 *
 * The account is a stateless `WorkerEntrypoint` whose props carry only a random `accountId`, minted
 * by `createAccount()`. Per-account state (display name, admin mark) lives in `StudioAccountState`;
 * studio data lives in the shared `ProbeNotesStore`.
 */

import { RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  AppUiContext,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  studioAccountDescription,
  studioVendorDescription,
  svgIcon,
} from "@veer/studio-kit/describe";
import { sharedStore } from "@veer/studio-kit/stores";
import { ProbeAppApi } from "./app-api.js";
import type { ProbeSession } from "./types.js";
import APP_HTML from "./generated/app.txt";
import TYPES_CODE from "./types.txt";

/** A flask: monochrome, since the sidebar draws app icons as a mask. */
export const PROBE_ICON = svgIcon(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
  "<path d='M221.69 199.77 160 96.92V40h8a8 8 0 0 0 0-16H88a8 8 0 0 0 0 16h8v56.92L34.31 199.77" +
  "A16 16 0 0 0 48 224h160a16 16 0 0 0 13.72-24.23ZM110.86 103.25A7.93 7.93 0 0 0 112 99.13V40h32" +
  "v59.13a7.93 7.93 0 0 0 1.14 4.12L183.36 167c-12 2.37-29.07 1.37-51.75-10.11-15.91-8.05-31.05-" +
  "12.32-45.22-12.81ZM48 208l28.54-47.58c14.25-1.74 30.31 1.85 47.82 10.72 19 9.61 35 12.88 48 " +
  "12.88a69.89 69.89 0 0 0 19.55-2.7L208 208Z'/></svg>",
);

/**
 * Frozen into each account when the Workshop creates it: change it only before the first deploy.
 * @returns The account description.
 */
export function describeProbeAccount(): AccountDescription {
  return studioAccountDescription({
    displayName: "Probe",
    icon: PROBE_ICON,
    tsType: "ProbeSession",
    appTitle: "Probe",
  });
}

/** @returns The vendor description. */
export function describeProbeVendor(): VendorDescription {
  return studioVendorDescription({
    displayName: "Probe",
    tagline: "Foundation's proving gate",
    description:
      "A shared notes board that exercises every piece the VEER Studio gates are built on: the " +
      "sidebar app, the agent session, approvals with simulation, and the audit log.",
    logo: PROBE_ICON,
  });
}

type ProbeAccountProps = { accountId: string };

@validateRpc()
export class ProbeAccount
  extends WorkerEntrypoint<Cloudflare.Env, ProbeAccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describeProbeAccount();
  }

  /** The facet class the Workshop installs into each of the owner's workspaces. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ProbeSession>>> {
    return this.ctx.exports.ProbeGatekeeper({ props: { accountId: this.ctx.props.accountId } });
  }

  /**
   * Opens the app. Runs on every mount, so it records the admin mark each time: set for an admin,
   * cleared for anyone else.
   */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const isAdmin = context.isAdmin === true;
    const state = this.#state();
    await state.markAdmin(isAdmin);
    const ui = new RpcStub(new ProbeAppApi({
      accountId: this.ctx.props.accountId,
      isAdmin,
      state,
      store: sharedStore(this.ctx.exports.ProbeNotesStore),
    }));
    return { iframeHtml: APP_HTML, ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Probe has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Probe has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Clears this account's display name and admin mark. The studio's notes stay. */
  async revoke(): Promise<void> {
    await this.#state().revoke();
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Probe has no connect flow.");
  }

  commitReconnect(_stageId: string): Promise<void> {
    throw new Error("Probe has no connect flow.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Open observers verify nothing, so the verifier carries nothing. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ProbeVerifier({});
  }

  #state() {
    return this.ctx.exports.StudioAccountState.getByName(this.ctx.props.accountId);
  }
}

@validateRpc()
export class ProbeVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeProbeVendor();
  }

  /** Mints a new account. Takes no identity: the Workshop calls it once per user. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ProbeAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Probe is provided automatically and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
