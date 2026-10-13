import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDIO_APP_CSP, studioAppConfig } from "../../build/app-build.ts";
import { TOKENS_FILE, WORKSHOP_STYLES, renderTokens } from "../../build/tokens.ts";

describe("Kumo token overrides", () => {
  // Fails after a submodule bump that changed the Workshop's tokens, until
  // `node packages/studio-kit/build/tokens.ts --write` is rerun.
  it("match the Workshop's stylesheet", () => {
    expect(readFileSync(TOKENS_FILE, "utf8")).toBe(renderTokens(readFileSync(WORKSHOP_STYLES, "utf8")));
  });

  it("copy light and dark Kumo colours, fonts and text sizes", () => {
    const css = renderTokens(readFileSync(WORKSHOP_STYLES, "utf8"));
    const [light, dark] = css.split('[data-mode="dark"]');
    expect(light).toContain("--color-kumo-base: #fcfcfb;");
    expect(light).toContain("--text-sm: 0.875rem;");
    expect(light).toContain("--font-sans:");
    expect(dark).toMatch(/--color-kumo-base: oklch\(/);
    expect(dark).not.toContain("--font-sans");
    // Only Kumo's semantic tokens: the Workshop's layout and brand extras stay out.
    expect(css).not.toMatch(/--container-|--shadow-stack|--color-compute-/);
  });

  it("refuses a stylesheet without the blocks", () => {
    expect(() => renderTokens("body { color: red; }")).toThrow(/No "@theme \{" block/);
  });
});

describe("studio app build", () => {
  it("declares a CSP with no network access", () => {
    expect(STUDIO_APP_CSP).toContain("connect-src 'none'");
    expect(STUDIO_APP_CSP).toContain("default-src 'none'");
    expect(STUDIO_APP_CSP).toContain("form-action 'none'");
  });

  it("builds one inlined page per gate", () => {
    const config = studioAppConfig({ packageDirectory: "/tmp/gate-x", gate: "x", title: "X" });
    expect(config.configFile).toBe(false);
    expect(config.build?.outDir).toBe("dist-app");
    expect(config.build?.cssCodeSplit).toBe(false);
    expect(config.build?.minify).toBe("terser");
    expect(config.build?.rollupOptions?.input).toBe("/tmp/gate-x/app/index.html");
    const names = (config.plugins ?? []).flat().map((plugin) =>
      plugin && typeof plugin === "object" && "name" in plugin ? plugin.name : "");
    expect(names).toEqual(expect.arrayContaining([
      "vite:singlefile", "studio-head", "studio-emit-app-text",
    ]));
  });

  it("refuses an invalid gate key", () => {
    expect(() => studioAppConfig({ packageDirectory: "/tmp", gate: "Gate X", title: "X" }))
      .toThrow(/lowercase/);
  });
});
