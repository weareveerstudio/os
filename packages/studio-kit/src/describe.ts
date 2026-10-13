/**
 * Vendor and account descriptions for a studio gate.
 *
 * Every studio gate is auto-provisioned, has an agent singleton, and has a sidebar app. An account's
 * description is stored when the Workshop creates the account and is not re-read afterwards, so
 * `singleton`, `providesUi`, the app title and the icon must be right on the first deploy: a later
 * change reaches only accounts created after it.
 */

import type {
  AccountDescription,
  AvatarImage,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * A monochrome SVG icon as a data URL. The sidebar draws app icons as a CSS mask, so only the
 * shape's alpha counts: use `fill='currentColor'` and no colours.
 * @param svg Complete `<svg>` markup with an `xmlns` attribute.
 * @returns The avatar image.
 */
export function svgIcon(svg: string): AvatarImage {
  if (!/^<svg\s[^>]*xmlns=['"]http:\/\/www\.w3\.org\/2000\/svg['"]/.test(svg.trim())) {
    throw new Error("svgIcon needs complete <svg> markup with an xmlns attribute.");
  }
  return { url: `data:image/svg+xml,${encodeURIComponent(svg.trim())}` };
}

/** The deployment every studio gate belongs to. */
export const STUDIO_URL = "https://os.veer.studio";

/**
 * Describes a studio gate's vendor.
 * @param input Display text and logo.
 * @returns A description with auto-provisioning on and sign-in off.
 */
export function studioVendorDescription(input: {
  displayName: string;
  tagline: string;
  description: string;
  logo: AvatarImage;
}): VendorDescription {
  return {
    displayName: input.displayName,
    url: STUDIO_URL,
    logo: input.logo,
    tagline: input.tagline,
    description: input.description,
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

/**
 * Describes a studio gate's auto-provisioned account: an agent singleton and a sidebar app.
 * @param input `tsType` names the session interface in the gate's `types.d.ts`; `appTitle` is the
 * sidebar entry.
 * @returns The account description, frozen into each account at creation.
 */
export function studioAccountDescription(input: {
  displayName: string;
  icon: AvatarImage;
  tsType: string;
  appTitle: string;
}): AccountDescription {
  return {
    displayName: input.displayName,
    avatar: input.icon,
    singleton: { tsType: input.tsType },
    providesUi: { title: input.appTitle, icon: input.icon },
  };
}
