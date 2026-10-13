import {
  applyAccentColor,
  type GatekeeperAppTheme,
} from "@gadgets/workshop-shared/theme";

/**
 * Applies the Workshop's resolved mode and accent to the document, as the Scheduler and Context
 * apps do. `data-mode` selects the dark token block in `tokens.css`; the accent overrides the brand
 * tokens, or clears them for the base palette.
 * @param theme The host's current theme.
 */
export function applyAppTheme(theme: GatekeeperAppTheme): void {
  const root = document.documentElement;
  root.dataset.mode = theme.mode;
  root.style.colorScheme = theme.mode;
  applyAccentColor(root.style, theme.accentColor);
}
