// The submodule packages that are members of this workspace (pnpm-workspace.yaml) are installed
// twice: by this repository's `pnpm install` and by `pnpm --dir cloudflare-os install`. Both write
// the same `cloudflare-os/packages/<name>/node_modules`, and the live Context, MCP and GitHub
// Workers bundle gatekeeper-kit and its siblings through that directory. Whichever install runs last
// decides what ships, so the two lockfiles must resolve every runtime dependency of those packages
// to the same version. The catalog mirror covers `catalog:` specifiers; this covers the rest
// (gatekeeper-kit's `jose`, for one).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Package name to resolved version, per importer, for one dependency group of a pnpm lockfile. */
type Importers = Map<string, Map<string, string>>;

/**
 * Reads the `dependencies` of every importer from a pnpm (v9+) lockfile's `importers:` block, by
 * indentation: importers at 2 spaces, groups at 4, packages at 6, `version:` at 8.
 */
function runtimeDependencies(lockfile: string): Importers {
  const importers: Importers = new Map();
  let inImporters = false;
  let importer: Map<string, string> | undefined;
  let inDependencies = false;
  let name: string | undefined;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) {
      inImporters = line === "importers:";
      continue;
    }
    if (!inImporters) continue;
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^ {2}(\S.*):$/))) {
      importer = new Map();
      importers.set(match[1].replace(/^'|'$/g, ""), importer);
    } else if ((match = line.match(/^ {4}(\w+):$/))) {
      inDependencies = match[1] === "dependencies";
    } else if (inDependencies && (match = line.match(/^ {6}(\S.*):$/))) {
      name = match[1].replace(/^'|'$/g, "");
    } else if (inDependencies && name && importer && (match = line.match(/^ {8}version: (.+)$/))) {
      // Drop the peer-resolution suffix: `1.2.3(peer@4)` and `1.2.3` are the same package.
      importer.set(name, match[1].replace(/^'|'$/g, "").replace(/\(.*$/, ""));
    }
  }
  return importers;
}

const root = runtimeDependencies(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
const submodule = runtimeDependencies(
  readFileSync(new URL("../cloudflare-os/pnpm-lock.yaml", import.meta.url), "utf8"));

const shared = [...root.keys()].filter((key) => key.startsWith("cloudflare-os/packages/"));

test("finds the submodule packages this workspace installs", () => {
  assert.ok(shared.includes("cloudflare-os/packages/gatekeeper-kit"), shared.join(", "));
  assert.ok(shared.includes("cloudflare-os/packages/workshop-shared"), shared.join(", "));
  // The parser really reads versions: these are gatekeeper-kit's registry dependencies.
  const kit = root.get("cloudflare-os/packages/gatekeeper-kit")!;
  assert.match(kit.get("jose") ?? "", /^\d+\.\d+\.\d+/);
  assert.match(kit.get("diff") ?? "", /^\d+\.\d+\.\d+/);
});

for (const key of shared) {
  test(`${key} resolves its runtime dependencies as the submodule does`, () => {
    const ours = root.get(key)!;
    const theirs = submodule.get(key.slice("cloudflare-os/".length));
    assert.ok(theirs, `${key} is not an importer in cloudflare-os/pnpm-lock.yaml`);
    for (const [name, version] of ours) {
      // Workspace links resolve inside each workspace; only registry versions can drift.
      if (version.startsWith("link:")) continue;
      assert.equal(version, theirs.get(name),
        `${key}: ${name} is ${version} here but ${theirs.get(name)} in the submodule's lockfile. ` +
        "Pin it to the submodule's version (catalog entry or override) so both installs agree.");
    }
  });
}
