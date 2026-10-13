// Builds a studio gate's sidebar app into one self-contained HTML file and emits it as
// `src/generated/app.txt`, which the gate's Worker imports as a Text module and returns from
// `startAppUi()` as `iframeHtml`.
//
// Modelled on gatekeeper-scheduler's `vite.app.config.ts`. React, Kumo's styles and Tailwind are all
// inlined (`vite-plugin-singlefile`), because the frame has `connect-src 'none'` and an opaque
// origin: it can load nothing. The frame's CSP is the app's own -- the Workshop injects none -- so
// this build writes it into every page rather than trusting each gate's `index.html` to carry it.
//
// A gate calls it from a `build-app.ts` of its own:
//
//   import { buildStudioApp } from "@veer/studio-kit/app-build";
//   await buildStudioApp({ packageDirectory: import.meta.dirname, gate: "probe", title: "Probe" });

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build, type InlineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** The frame's Content Security Policy: inline code only, and no network at all. */
export const STUDIO_APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "worker-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ") + ";";

export type StudioAppBuildOptions = {
  /** The gate package's root: holds `app/index.html` and receives `dist-app/` and `src/generated/`. */
  packageDirectory: string;
  /** The gate's key, e.g. `"probe"`: names the bundle in stack traces. */
  gate: string;
  /** The page title. */
  title: string;
  /** Skips minification, for debugging. Never for a deploy. */
  unminified?: boolean;
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Writes the head every studio page needs: CSP, viewport, title, and the pre-paint theme. */
function studioHead(title: string): Plugin {
  return {
    name: "studio-head",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (/http-equiv=["']Content-Security-Policy/i.test(html)) {
          throw new Error("The studio app build writes the CSP itself; remove it from index.html.");
        }
        return {
          html,
          tags: [
            { tag: "meta", attrs: { charset: "UTF-8" }, injectTo: "head-prepend" },
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: STUDIO_APP_CSP },
              injectTo: "head-prepend",
            },
            {
              tag: "meta",
              attrs: { name: "viewport", content: "width=device-width, initial-scale=1.0" },
              injectTo: "head",
            },
            { tag: "title", children: escapeHtml(title), injectTo: "head" },
            // Matches the host's mode before the first paint; the theme subscription takes over.
            {
              tag: "script",
              children:
                'document.documentElement.dataset.mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";',
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}

/**
 * Throws unless the page's live markup (outside comments) carries the CSP. Vite places injected
 * tags by matching `<head>` textually, so a comment mentioning it would swallow them.
 * @param html The built page.
 */
export function assertCspApplied(html: string): void {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  if (!/<meta http-equiv="Content-Security-Policy" content="[^"]*connect-src &#39;none&#39;/.test(live)) {
    throw new Error("The built app page has no live Content-Security-Policy meta tag.");
  }
}

/** Copies the built page to `src/generated/app.txt`, skipping the write when nothing changed. */
function emitAppText(packageDirectory: string, gate: string): Plugin {
  return {
    name: "studio-emit-app-text",
    closeBundle() {
      const built = resolve(packageDirectory, "dist-app", "app", "index.html");
      const html = readFileSync(built, "utf8").replace(
        /(<script type="module"[^>]*>)([\s\S]*?)(<\/script>)/,
        `$1$2\n//# sourceURL=app:///gatekeeper/${gate}/${gate}-app.js\n$3`,
      );
      assertCspApplied(html);
      const output = resolve(packageDirectory, "src", "generated", "app.txt");
      const contents = `<!-- Generated from packages/gate-${gate}/app. Do not edit. -->\n${html}`;
      if (existsSync(output) && readFileSync(output, "utf8") === contents) return;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, contents);
    },
  };
}

/**
 * Loads `*.txt` imports as strings, the way wrangler's Text-module rule does at deploy. For a gate's
 * vitest config: under Vite a `.txt` import would otherwise resolve to an asset URL.
 * @returns A Vite plugin.
 */
export function textModules(): Plugin {
  // Resolved here rather than left to Vite, which follows symlinks: `types.txt -> types.d.ts`
  // would otherwise load as an empty declaration module.
  const prefix = "\0studio-text:";
  return {
    name: "studio-text-modules",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(".txt") || !importer) return null;
      return prefix + resolve(dirname(importer.split("?")[0]), source);
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `export default ${JSON.stringify(readFileSync(id.slice(prefix.length), "utf8"))};`;
    },
  };
}

/**
 * The Vite configuration for a studio app.
 * @param options Where the gate lives and what to call it.
 * @returns An inline config for `vite.build`.
 */
export function studioAppConfig(options: StudioAppBuildOptions): InlineConfig {
  const { packageDirectory, gate, title, unminified = false } = options;
  if (!/^[a-z][a-z0-9-]*$/.test(gate)) throw new Error(`Gate key "${gate}" must be lowercase.`);
  return {
    configFile: false,
    root: packageDirectory,
    logLevel: "warn",
    plugins: [
      react(),
      tailwindcss(),
      viteSingleFile(),
      studioHead(title),
      emitAppText(packageDirectory, gate),
    ],
    // One copy each: two Reacts break hooks, and two capnwebs cannot exchange stubs.
    resolve: { dedupe: ["react", "react-dom", "capnweb", "@cloudflare/kumo"] },
    build: {
      outDir: "dist-app",
      emptyOutDir: true,
      minify: unminified ? false : "terser",
      terserOptions: { compress: { passes: 2 }, format: { comments: false } },
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: resolve(packageDirectory, "app", "index.html"),
        output: { entryFileNames: `${gate}-app.js` },
      },
    },
  };
}

/**
 * Builds the app and writes `src/generated/app.txt`.
 * @param options Where the gate lives and what to call it.
 */
export async function buildStudioApp(options: StudioAppBuildOptions): Promise<void> {
  await build(studioAppConfig(options));
}
