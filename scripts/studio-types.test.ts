// Every studio gate's `src/types.d.ts` is the agent's only documentation for that gate, served
// verbatim by `getTypeScriptTypes()`. It must stand alone: the agent sees no other file, so an import
// names a type it can never read. Upstream lints this for its own gatekeepers only, so this repo
// checks its own (docs/studio-os/architecture.md, "The agent path").

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const packages = new URL("../packages/", import.meta.url);

function gateDirectories(): string[] {
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("gate-"))
    .map((entry) => join(packages.pathname, entry.name));
}

test("finds the studio gates", () => {
  assert.ok(gateDirectories().some((dir) => dir.endsWith("gate-probe")));
});

for (const dir of gateDirectories()) {
  const name = dir.split("/").at(-1)!;
  const types = join(dir, "src", "types.d.ts");

  test(`${name}: types.d.ts imports nothing but cloudflare:workers`, () => {
    assert.ok(existsSync(types), `${name} has no src/types.d.ts`);
    const source = readFileSync(types, "utf8");
    const imports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g)]
      .map((match) => match[1])
      .concat([...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]))
      .concat([...source.matchAll(/\/\/\/\s*<reference\s+(?:path|types)=["']([^"']+)["']/g)]
        .map((match) => match[1]));
    assert.deepEqual(imports.filter((specifier) => specifier !== "cloudflare:workers"), [],
      `${name}/src/types.d.ts must be self-contained`);
  });

  test(`${name}: types.txt is the same file as types.d.ts`, () => {
    // The Worker imports `types.txt` as a Text module; a copy could drift from the declarations.
    const text = join(dir, "src", "types.txt");
    assert.equal(realpathSync(text), realpathSync(types));
  });
}
