# Cloudflare OS — Technical Exploration

Working notes for the `os.veer.studio` deployment: what this wrapper changes relative to the starter,
what the upstream platform actually provides, and what each upgrade changed.

**Scope.** Read from the pinned submodule at `ef65348f` (2026-09-28). Every `file:line` reference in
§§3–14 was re-verified at that commit on 2026-09-29. They drift on every bump — after the next one,
treat them as "grep for the identifier". Anything not verified against source is marked as such.
Unqualified `overseer.ts` / `gatekeeper.ts` mean `workshop-backend/src/overseer.ts` and
`workshop-shared/src/gatekeeper.ts`.

**Status.**

- **Live:** pin `b304e8c2` plus the GitHub Gatekeeper, deployed 2026-10-06 14:28–14:33 UTC from
  root `962fed3` (§1.6). CLI-checkable verification passed. GitHub has no OAuth App or secrets yet,
  and the authenticated browser checks are outstanding (§12).
- **Previous:** the same pin without GitHub, deployed 2026-10-06 12:17–12:23 UTC from `dd06ecd`
  (§13.1) — the rollback baseline. Before that, `ef65348f` (2026-09-29, §13.2).
- `file:line` references below were verified at `ef65348f`, not re-verified at `b304e8c2`.

---

## Contents

1. [Deployment: what the wrapper changes](#1-deployment-what-the-wrapper-changes)
2. [Live account inventory](#2-live-account-inventory)
3. [Context Gatekeeper](#3-context-gatekeeper)
4. [Blueprints and output formats](#4-blueprints-and-output-formats)
5. [Theming and CSS](#5-theming-and-css)
6. [Access and permissions](#6-access-and-permissions)
7. [Authentication mechanisms](#7-authentication-mechanisms)
8. [The Gatekeeper contract](#8-the-gatekeeper-contract)
   - 8.1 [The export map](#81-the-export-map)
   - 8.2 [Sessions and the ApprovalQueue](#82-sessions-and-the-approvalqueue)
   - 8.3 [“Simulating actions”](#83-simulating-actions)
   - 8.4 [Singleton gatekeepers and ambient capsules](#84-singleton-gatekeepers-and-ambient-capsules)
   - 8.5 [Management UIs (`providesUi`)](#85-management-uis-providesui)
   - 8.6 [Packaging note](#86-packaging-note)
9. [Gatekeeper survey](#9-gatekeeper-survey)
    - 9.5 [`gatekeeper-email` — the Gatekeeper that *is* the service](#95-gatekeeper-email--the-gatekeeper-that-is-the-service)
10. [Credentials and secrets](#10-credentials-and-secrets)
11. [Design sketches](#11-design-sketches)
    - 11.1 [Client portal and billing](#111-client-portal-and-billing)
    - 11.2 [Media service on R2](#112-media-service-on-r2)
12. [Open items](#12-open-items)
13. [Upgrade log](#13-upgrade-log)
    - 13.1 [`ef65348f` → `b304e8c2` (2026-10-06) — deployed](#131-ef65348f--b304e8c2-2026-10-06--deployed)
    - 13.2 [`08afe059` → `ef65348f` (2026-09-29) — deployed](#132-08afe059--ef65348f-2026-09-29--deployed)
    - 13.3 [`54d5d8b0` → `08afe059` (2026-09-13) — deployed](#133-54d5d8b0--08afe059-2026-09-13--deployed)
    - 13.4 [`6478a144` → `54d5d8b0` (2026-09-09) — deployed 2026-09-10](#134-6478a144--54d5d8b0-2026-09-09--deployed-2026-09-10)
14. [Git-backed code storage and worktrees](#14-git-backed-code-storage-and-worktrees)
    - 14.1 [One store per workspace, not one repo per gadget](#141-one-store-per-workspace-not-one-repo-per-gadget)
    - 14.2 [What is *not* involved: Artifacts, R2, refs](#142-what-is-not-involved-artifacts-r2-refs)
    - 14.3 [The merge model: the chat is the branch](#143-the-merge-model-the-chat-is-the-branch)
    - 14.4 [Worktrees — mounting a remote commit](#144-worktrees--mounting-a-remote-commit)
    - 14.5 [The git flows exposed to the agent and to gadgets](#145-the-git-flows-exposed-to-the-agent-and-to-gadgets)
    - 14.6 [`GitCache` — the gatekeeper side](#146-gitcache--the-gatekeeper-side)
    - 14.7 [Spawned agents](#147-spawned-agents)
    - 14.8 [What this means for us](#148-what-this-means-for-us)

---

## 1. Deployment: what the wrapper changes

This deployment was created by the hosted flow (`os.cloudflare.app/deploy`) and ejected to this
starter repo. Four problems had to be solved before `pnpm deploy` was safe to run (§1.1–1.4), and
§1.6 adds two upstream Gatekeepers the starter does not deploy. Together these are the wrapper's only
functional divergence from `cloudflare/cloudflare-os-starter`.

### 1.1 The MCP Gatekeeper would have been silently orphaned

**The bug.** `generateConfigs` assigns `router.services` and `workshop.services` *wholesale*
(`scripts/deploy.ts`), and knew only four Gatekeeper bindings. Because `wrangler deploy` replaces
bindings, deploying would have dropped `GATEKEEPER_MCP` — leaving `veeros-gk-mcp` running with its
Durable Object data intact but bound to nothing, and the connector silently gone from the app.

This is the failure mode `docs/migrate-from-hosted.md` §7 describes: Gatekeepers installed through
the hosted wizard keep running as Workers, but the generated configs no longer carry their
`GATEKEEPER_*` service binding.

**The fix.** MCP became a first-class deployable Worker in `scripts/deploy.ts`:

- `packageDirs.mcp` → `cloudflare-os/packages/gatekeeper-mcp`
- Bound as `GATEKEEPER_MCP` on the router (bare) and on the Workshop (`entrypoint:
  "GatekeeperVendor"`, no props — only Context takes a prop)
- One build step, `vp run --no-cache build` on `@gadgets/mcp-gatekeeper`. Unlike Context and
  Scheduler it needs no paired `build:app` call, because its `build` is a Vite+ *task* declaring
  `dependsOn: ["build:configurator"]`, so `--no-cache` reaches the codegen through the dependency
  rather than being swallowed by a nested `vp run`.
- Deployed before the Workshop, after the Scheduler

Router path is `/gatekeeper/mcp` — `<short>` is the binding name minus its prefix, lowercased.

### 1.2 `BASE_URL` was missing on the MCP Worker

**The bug, and why it was easy to miss.** The hosted deploy sets `BASE_URL` on every Gatekeeper;
this wrapper set it on none. That never mattered, because neither Context nor Scheduler reads it —
only OAuth-style Gatekeepers do. MCP is the first one this deployment runs.

`getBaseUrl()` in `gatekeeper-mcp` falls back to `http://localhost:8787/gatekeeper/mcp` when unset,
and it feeds the connect form and **OAuth callback** handler. Unset in production, every OAuth
redirect handed to a remote MCP server would have pointed at localhost — a failure surfacing only
when a user first tried to connect a server.

**The fix.** `deploy.ts` derives it: `BASE_URL: ${origin}/gatekeeper/mcp`. Verified in the dry-run
as `https://os.veer.studio/gatekeeper/mcp`.

> **Rule for any future OAuth Gatekeeper: it needs `BASE_URL`.** Nothing enforces this — the deploy
> succeeds without it.

### 1.3 Custom Gatekeeper and Error Reporter made optional

Error reporting was already a clean flag. The custom Gatekeeper was not: its names were in
`requiredPaths` and `GATEKEEPER_CUSTOM` was bound unconditionally on both the router and the
Workshop.

It now mirrors the `errorReporter` pattern exactly — gated in validation, placeholder scanning,
Worker-name uniqueness, config generation, both binding lists, the build, and the deploy. Code stays
in `packages/custom-gatekeeper/` for a later iteration; nothing is built, deployed, or bound while
`customGatekeeper.enabled` is false.

**Side effect: `pnpm check` never compiles a disabled package.** Only `pnpm lint` type-checks
`packages/custom-gatekeeper`. That is how a Gatekeeper-contract change left it failing to compile
for a whole pin without anyone noticing (§13.2). Run `pnpm lint` on every bump.

### 1.4 AI Gateway name was wrong

`aiGateway.name` was `"default"`. The hosted flow creates `<instance>-ai`, and the deployed Workshop
confirmed `CF_AI_GATEWAY ("veeros-ai")`. Per `docs/migrate-from-hosted.md` §5 a wrong gateway name
**silently empties the model picker** — the deployment looks healthy and offers no models.

Also added `"anthropic"` to `providers`. The `veeros-ai_anthropic_default` key lives in the
**gateway's own Secrets Store**, not the Worker, so it needs no `CF_AI_GATEWAY_API_TOKEN` — but the
provider must be listed or its models are never advertised. Provider order is irrelevant; it is
parsed into a `Set`.

### 1.5 Tests

`scripts/deploy.test.ts` gained four cases covering the new paths — a disabled Gatekeeper dropping
out of *both* binding lists, an enabled one still requiring a Worker name, build steps skipped when
disabled, and MCP's `BASE_URL` / `MCP_ALLOW_INSECURE` vars. **30/30 pass** (still, at `ef65348f`);
**37/37** after §1.6.

### 1.6 GitHub and Email Gatekeepers, and the vendor-Gatekeeper table

**What.** The upstream GitHub Gatekeeper (`cloudflare-os/packages/gatekeeper-github`,
`@gadgets/github-gatekeeper`) is deployed as `veeros-gk-github`. The Email Gatekeeper
(`gatekeeper-email`, `@gadgets/email-gatekeeper`) is wired the same way but `email.enabled: false`,
so nothing about it is built, deployed or bound. Commit `962fed3` (branch `feat/github-gatekeeper`).

**One table instead of three copies.** MCP, GitHub and Email are the same shape to the wrapper: an
`enabled` flag, a Worker name, and a `BASE_URL` derived from the public origin; no props, no storage
bindings of their own. `scripts/deploy.ts` now drives all three from `vendorGatekeepers` (key,
binding, pnpm package). Each one gets everything §1.1 gave MCP — required `workers.<key>.name` when
enabled, placeholder stripping and uniqueness only when enabled, a bare router binding, a
`GatekeeperVendor` Workshop binding, one `vp run --no-cache build` (all three `build`s are the shared
configurator task with `dependsOn: ["build:configurator"]`), and a deploy slot after MCP and before
the custom Gatekeeper. The path is derived from the binding by the router's own rule
(`GATEKEEPER_GITHUB` → `/gatekeeper/github`), so `BASE_URL` cannot disagree with it. **MCP's
generated config is byte-identical to before** (diffed against the pre-change output), and its
position in both binding lists is unchanged; Context and Scheduler are untouched.

That also closes §1.2's rule for this class: a Gatekeeper in the table gets `BASE_URL`
automatically. One wired any other way still does not.

**GitHub's credentials are not in the config.** It reads `CLIENT_ID` and `CLIENT_SECRET` (upstream
`deploy-inputs.json` marks both secrets). They are deliberately *not* in `secrets.required` —
wrangler would then refuse the first deploy, before the Worker they belong to exists. Instead
`pnpm deploy` prints, after the router deploy, the callback URL and the two `secret put` commands.
Until they are installed the Worker is harmless: `describe()` needs no secrets, so GitHub should
already be listed as a connector (not checked in a browser), and a connect attempt gets upstream's
"not configured" page. It advertises
`providesAuth`, but sign-in through a Gatekeeper is opt-in via `AUTH_GATEKEEPERS`, which the wrapper
does not set, so the Access sign-in boundary is unchanged. **Authority to know about:** the connect
scope is `repo`, `read:user`, `user:email` — `repo` is read/write on every repository the
connecting user can reach, gated per action by approval prompts (§8.2).

**Email stays off** pending the Email Routing decision (which addresses, on which zone) and the
`getEmailHost` display issue (§9.5). Enabling it is `"email": { "enabled": true }` plus uncommenting
`workers.email` — the generated `BASE_URL` would be `https://os.veer.studio/gatekeeper/email`.

**Tests.** Seven new cases: GitHub enabled → bare on the router, `GatekeeperVendor` with no props on
the Workshop, `BASE_URL` derived (custom domain and workers.dev), no `secrets.required`, one build
step; GitHub disabled → absent from both lists and the build; Email disabled by default → absent;
Email enabled → its own `BASE_URL` and the binding order; MCP's output unchanged with both others on;
validation of the new blocks. The fixture keeps both off, so every pre-existing assertion is
untouched.

**Deploy record.** Deployed 2026-10-06 14:28–14:33 UTC, account `cae2b6350c3a5a8bc9451652ffb0c9d7`,
route `os.veer.studio`, from root commit `962fed3` / submodule `b304e8c2`. `pnpm lint`, `pnpm check`
(37/37; router and backend dry-runs listing `GATEKEEPER_GITHUB`, no email anywhere, generated
configs removed) and `pnpm test` passed first. The live versions were re-read immediately before and
matched §13.1's exactly; `veeros-gk-github` did not exist. All six active Workers deployed in the
script's order, exit 0.

| Worker | Previous version (rollback target) | New version |
|---|---|---|
| `veeros-gk-context` | `8a597940-4016-4872-9d0e-09242537a86e` | `1b7f16e1-6c98-4886-a351-9c30a40d0281` |
| `veeros-gk-scheduler` | `7efc47af-e27a-44c4-8604-cd810d9bac02` | `8f8ea631-4edd-4b51-bb04-d2d75c90a276` |
| `veeros-gk-mcp` | `d25238aa-8803-4106-82b8-a3ea6beaaf10` | `f5d3ce61-f3b5-4ed3-9c3b-6916d636ccdc` |
| `veeros-gk-github` | — (new Worker, DO migration `v0`: `UserAccount`, `GitHubGatekeeperImpl`) | `7afc511c-3697-4b4c-8253-4c3fccf4dc32` |
| `veeros-backend` | `10cea740-8393-43ba-bdb3-4ee02049f07c` | `91e63709-38f6-47b0-be19-73e7977bb394` |
| `veeros` (router) | `396ae1c7-0d45-4c89-b084-4f793b6d0409` | `85bd528c-f5cd-4886-9c7a-ac5f992d7df8` |

**Verified after deploy:** valid TLS on `os.veer.studio`; unauthenticated requests to `/`, `/api/`,
`/admin`, `/gatekeeper/github`, `/gatekeeper/github/oauth` and `/gatekeeper/mcp` all 302 to
`veerstudio.cloudflareaccess.com` carrying the configured audience; every Worker but the router
reported *"No targets deployed"*, `veeros-gk-github` included; `versions view` of the new backend
and router differs from the previous versions by exactly one line each, the added
`GATEKEEPER_GITHUB` binding (`veeros-gk-github#GatekeeperVendor` / bare `veeros-gk-github`);
Context, Scheduler and MCP versions are identical to their predecessors apart from ID and time; the
GitHub version carries `BASE_URL = "https://os.veer.studio/gatekeeper/github"` and no other binding.
**Not verified:** a GitHub connect (no OAuth App exists yet) and everything needing an authenticated
browser session (§12).

**Rollback.** Context, Scheduler and MCP changed nothing but the version, so they need none. Rolling
the backend and router back to the previous versions above unbinds GitHub; `veeros-gk-github` can
then stay deployed and unbound — never delete it once an account is connected, since its Durable
Objects hold the grants.

---

## 2. Live account inventory

Verified against the account on 2026-10-06, before and after the `b304e8c2` deploy and the GitHub
Gatekeeper deploy (`wrangler whoami`, `deployments list`, `secret list`, `versions view`).

| Item | Value |
|---|---|
| Account | VEER Studio · `cae2b6350c3a5a8bc9451652ffb0c9d7` |
| Public origin | `https://os.veer.studio` (custom domain on the router) |
| AI Gateway | `veeros-ai`, providers `cloudflare` + `anthropic` |

### Workers

All six were deployed 2026-10-06 14:28–14:33 UTC at pin `b304e8c2` from root `962fed3` (§1.6). The
previous column holds the 12:17–12:23 versions of the same pin, without GitHub — the rollback
targets. The `ef65348f` versions before those are in §13.1, with its caveats.

| Worker | Role | Live version | Previous version |
|---|---|---|---|
| `veeros` | Router — the only public route | `85bd528c-f5cd-4886-9c7a-ac5f992d7df8` | `396ae1c7-0d45-4c89-b084-4f793b6d0409` |
| `veeros-backend` | Workshop — **all user data** (Durable Objects) | `91e63709-38f6-47b0-be19-73e7977bb394` | `10cea740-8393-43ba-bdb3-4ee02049f07c` |
| `veeros-gk-context` | Context Gatekeeper | `1b7f16e1-6c98-4886-a351-9c30a40d0281` | `8a597940-4016-4872-9d0e-09242537a86e` |
| `veeros-gk-scheduler` | Scheduler Gatekeeper | `8f8ea631-4edd-4b51-bb04-d2d75c90a276` | `7efc47af-e27a-44c4-8604-cd810d9bac02` |
| `veeros-gk-mcp` | MCP Gatekeeper | `f5d3ce61-f3b5-4ed3-9c3b-6916d636ccdc` | `d25238aa-8803-4106-82b8-a3ea6beaaf10` |
| `veeros-gk-github` | GitHub Gatekeeper — no secrets yet (§12) | `7afc511c-3697-4b4c-8253-4c3fccf4dc32` | — (new) |

Email Gatekeeper, Custom Gatekeeper and Error Reporter are disabled — not deployed, not bound.
`wrangler deployments list` prints **oldest-first**; the current version is the *last* entry.

### Storage

| Binding | Resource |
|---|---|
| `CONTEXT_COLLECTIONS` | `b203bda152124baa9ff21e147c182537` (`veeros-context-collections`) |
| `BLUEPRINTS` | `4ee876087f654c14a2129953d0308152` (`veeros-blueprints`) |
| `AVATARS` | `380a24bf2d82473fab8040db6c91678d` (`veeros-avatars`) |
| `BLUEPRINT_CONTENT` | `veeros-blueprint-content` (R2) |
| `ARTIFACTS` | `veeros-context-collections` (Artifacts namespace; `context.artifacts.enabled: true`) |

Workshop Durable Object migrations live: `v0`–`v3`, all additive `new_sqlite_classes` — `v3`
(`UserDirectoryDurableObject`) arrived with `ef65348f` (§13.2). Separately, the Overseer's own
storage schema is at version 5 from `b304e8c2` on each workspace's first wake (§13.1).

### Notes

- The Workshop still carries a leftover `CF_AI_GATEWAY_API_TOKEN` secret from the hosted flow
  (present 2026-10-06). It survives deploys and is **unused** — transport picks the `WORKERS_AI`
  binding unless `CF_AI_GATEWAY_USE_BINDING=false`.
- `DEPLOY_URL` was dropped, removing the "manage this deployment" link. Expected; documented in
  `docs/migrate-from-hosted.md` §7.
- `context.sharingDomain: null` derives `https://os.veer.studio`, which **matches** the hosted
  instance's origin — the Context data boundary was preserved. Had the hosted instance been on
  `workers.dev`, this would have silently hidden all collections.
- Local Node is 24.15.0 against a declared `>=24.19.0`. Only a warning.
- `veeros-gk-github` carries no `CLIENT_ID` / `CLIENT_SECRET` yet; until it does, a connect attempt
  shows upstream's "not configured" page. Its OAuth callback, `/gatekeeper/github/oauth`, sits behind
  Access like every router path — fine for a browser redirect from a signed-in user.

---

## 3. Context Gatekeeper

An **ambient** Gatekeeper holding collections of documents, exposed to the agent as a catalog it can
search and read. UI at `https://os.veer.studio/gatekeeper/context`. All paths below are in
`packages/gatekeeper-context/src/`.

### 3.1 Collections

Two content sources (`ContextCollectionContent`, `context-types.ts:96`):

| Source | Content managed via | Requires |
|---|---|---|
| `{ source: "web" }` | The Context UI | — |
| `{ source: "git", remote, branch, lastRefreshedAt, commit? }` | `git push` to an Artifacts repo | Artifacts (enabled) — else *"Git-backed Context collections are not enabled."* (`context-api.ts:110`) |

Visibility is `"public"` or `"private"` within a sharing domain, and the authorization is only two
branches (`#assertCanRead` / `#assertCanWrite`, `context-api.ts:89`–`108`):

| Visibility | Read | Write |
|---|---|---|
| `private` | Owning account only | Owning account only |
| `public` | Every user in the deployment | **Admins only** (creating one also needs admin, `:133`) |

There is **no ACL, no collaborator list, and no share link for collections.** "Shared with these
three people but not everyone" does not exist. `public` + admin-only-write is the intended shape for
a curated house knowledge base.

### 3.2 Skills

A skill is **any file named exactly `SKILL.md`**, anywhere in any collection
(`isSkillManifestPath`, `agent-skill.ts:130`). No manifest, no registration, no admin step. Each
becomes a slash command *and* an agent catalog entry.

```markdown
---
name: weekly-status
description: Draft the weekly client status note from the project's context docs.
---

Write a status update for $ARGUMENT following our house format...
```

- `name` — `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64 chars → `/weekly-status`
- `description` — ≤1024 chars after trimming; this is what the agent uses to judge relevance
- `$ARGUMENT` is substituted; if absent, the text is appended as `ARGUMENT: <args>`
  (`buildAgentSkillMessage`, `agent-skill.ts:106`)
- The body is delivered with a **skill root**, so a skill can be a folder (`SKILL.md` plus reference
  docs) and cite siblings by relative path
- The catalog lists collections first, then at most **150** skills
  (`AGENT_SKILL_CATALOG_MAX_ENTRIES`, `agent-skill.ts:17`) and sets `truncated` past that. Skills
  beyond the cap remain reachable through `list()`/`search()` but are unadvertised.

### 3.3 Size limits

**One document limit shared by both modes: `MAX_DOCUMENT_BODY_BYTES = 1_800_000`**
(`context-types.ts:212`, "headroom below SQLite's 2 MB serialized-value limit"). Enforcement differs,
and this is the trap:

| | Web / UI mode | Git mode |
|---|---|---|
| Checked at | `context-collection.ts:385`, on write | `artifact-sync.ts:259`, on sync |
| Measures | Body bytes **plus** the record's JSON metadata | Raw blob bytes |
| Over limit | **Throws** *"Document is too large…"* | **Silently skipped** — logs `context.file.oversized.skipped` |

Push a 2 MB file to a git-backed collection and it simply is not there. No error, no failed sync.

- **Bodies are stored as bytes** (UTF-8 for text, raw for binary; `context-storage.ts:23`), so the
  binary ceiling is ~1.8 MB of raw bytes. Binary still crosses RPC as canonical base64.
- **`MAX_GIT_DIR_BYTES = 64 MB`** (`artifact-sync.ts:26`) is a *soft* cap on the packed repository
  loaded into memory during clone/fetch — not on unpacked content. Clones are shallow and
  single-branch (`depth: 1`); once the cached gitdir exceeds the budget it reclones shallow and logs
  `artifacts.git.cache.transfer.budget.exceeded` (`:176`). History therefore does not accumulate
  against it indefinitely.
- Path length: 1024 characters (`MAX_DOCUMENT_PATH_LENGTH`, `context-collection.ts:30`).

### 3.4 Indexing — there is none

`search()` (`context-collection.ts:617`, "Linear scan over one collection") is a **linear scan with
substring scoring**:

```ts
for (let record of this.storage.documents.list()) {
  for (let token of tokens) {
    if (nameLower.includes(token)) score += 10
    if (descLower.includes(token)) score += 5
    if (bodyLower.indexOf(token) >= 0) score += 1   // + first snippet
  }
}
results.sort((a, b) => b.score - a.score)
return results.slice(0, limit)   // default 20
```

No embeddings, no vector search, no inverted index, no BM25, no stemming. Body matching is skipped
entirely for non-text types, so **binary files are searchable by name and description only**.

**Name is worth 10× a body hit; description 5×.** `description` is auto-extracted
(`description-extractors.ts:82`–`110`): from a `description` or `summary` key in Markdown
frontmatter; from a top-level `description`/`summary` key — or else the leading `#` comment block —
in YAML; from `_comment`, `description` or `summary` in JSON. Naming files well and writing real
descriptions is the highest-leverage thing available for retrieval quality.

Practical consequences:

- Many small documents beat few large ones — a body hit scores +1 and only the *first* snippet is
  captured, so a large reference doc is a weak search target regardless of relevance.
- The agent matches literal substrings. Consistent house vocabulary does the work an embedding model
  would otherwise do.

### 3.5 The agent's read path

Three RPCs on `LibraryReadSession` (`library-read.ts:33`), scoped to *enabled* collections:

| Call | Behaviour |
|---|---|
| `list({collectionId?, path?})` | Browse collections or a path prefix |
| `search(query, {collectionId?, limit=20})` | Fans out, `MAX_COLLECTION_FANOUT = 8` concurrent |
| `read(docId)` | Full document; binary as a `data:` URI |

Every read/list/search is authorized as an **observation** and attributed to the collections it
reveals; all three record nothing when empty.

Above them sits the catalog: collections (against `AGENT_CATALOG_MAX_ENTRIES = 1000`) then up to 150
skills. Skill entries — only those — carry the literal instruction `"Agent Skill. Read with
env[N].read(id) and console.log(document.content)."`

**The catalog is not an observation** (since #267, `library-gatekeeper.ts:321`). The Workshop loads
it into every chat's prompt on every turn, so a skill added mid-chat is visible on the next turn,
and nothing that needs observer verification may appear in it. Reading an item through the session
is still an observation.

**Git refresh is lazy** — `listAgentSkills`, `listContextDocuments`, `getContextDocument` (what
`read()` uses) and `search` each kick off a background refresh, throttled to once a minute
(`GIT_REFRESH_MIN_INTERVAL_MS`, `context-collection.ts:35`). After a `git push`, the update lands on
a *subsequent* read. The Context UI's explicit sync is `syncContextCollectionArtifactSource`.

---

## 4. Blueprints and output formats

### 4.1 What a blueprint is

A snapshot of a gadget's **source at one git commit** — `Overseer.snapshotCode(commitId)`
(`overseer.ts:8251`) reads the commit's files and packs them as a gzipped Yjs V2 snapshot with no
history — plus binding *requirements* and metadata. It does **not** capture SQLite storage, chat
history, or credentials — only the *shape* of each binding. Blueprint records reference a
`commitId`; `codeVersion` survives only as a legacy field (`overseer.ts:561`–`582`).

User blueprints are still made in a running Workshop and exported as `.gadget` files. The bundled
ones are now plain TypeScript source (§4.2).

### 4.2 The bundled blueprints

They live in their own package, **`packages/bundled-blueprints/blueprints/<name>/`** (#466):

| Directory | Blueprint ID | Output |
|---|---|---|
| `workspace-docs` | `format.document` | `document` / Docs / `fileText` |
| `workspace-sheets` | `format.spreadsheet` | `spreadsheet` / Sheets / `table` |
| `workspace-slides` | `format.slides` | `presentation` / Slides / `presentation` |

These three are the only bundled blueprints; all declare `bindings: {}`. Each directory holds:

- `blueprint.json` — `blueprintId`, `title`, `description`, `output`, `author`, `revision`,
  `created`, `version`, `lastUpdated`, `bindings`
- `files/` — `README.md`, `client.ts`, `server.ts`, `lib/protocol.ts` (Sheets adds `lib/xlsx.ts`,
  `lib/zip.ts`, `lib/formula.ts`)
- optionally `__tests__/`, never part of the archive

The TypeScript is bundled at build time into readable `client.js`/`server.js`, with two shared
gadget libraries inlined: `libraries/ui` and `libraries/sync`, imported as
`@gadgets/bundled-blueprints/libraries/<name>/client|server`. The build is
`workshop-backend/scripts/build-bundled-blueprints.ts`, generating the gitignored
`workshop-backend/src/generated/bundled-blueprints.ts`. The install fingerprint is
`${blueprintId}@${revision}+${contentHash}+fingerprint([title, description, author, output])`
(`workshop-backend/src/bundled-blueprints.ts:30`), so a content change reinstalls even without a
`revision` bump.

**Workspace Docs' model.** Read `workspace-docs/files/server.ts` directly. It stores one atomic
`document:v2` snapshot — title, global revision, ordered blocks — with concurrent edits serialized by
a global revision number: block granularity, "not a character-level CRDT" (its `README.md:30`, `:64`).
It builds on `libraries/sync/server`; read that before designing our own blueprints' sync.

**The `.gadget` archive format** is still what `/admin` exports and the importer reads: a 24-byte
header (magic `0xec2e2d3a2300e317`, u32 version = 1, u32 metadata length, u64 content length), JSON
metadata (≤64 KiB), then the gzipped Yjs snapshot (≤32 MiB) — `workshop-backend/src/blueprint-archive.ts:3`–`21`.
`scratchpad/extract-gadget.mjs` decodes one: `node extract-gadget.mjs <file.gadget> <output-dir>`.

### 4.3 Formats and the Outputs page

A *format* is an ordinary blueprint the deployment has **promoted** (`AdminConfig.formats`,
`admin-config.ts:62`; the admin **Formats** panel). Each `FormatCuration` (`:69`) carries `enabled`,
an optional `agentHint`, and optional `overrides: Partial<BlueprintOutput>` — presentation the
deployment substitutes for the blueprint's own ("an org that calls its decks *Briefings*"), without
touching the blueprint.

A blueprint may declare `BlueprintMetadata.output` (`workshop-shared/src/api.ts:4274`): a grouping
`id`, a `noun`/`plural`, and an `icon` from a closed set (`api.ts:1546`):

```ts
export const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"] as const;
```

**Outputs filter chips** are built in `workshop-frontend/src/routes/outputs.tsx:530` in three passes:

1. `Apps` seeded first, unconditionally
2. Each promoted format, in deployment order
3. Any `output.id` present on existing outputs but not yet covered — *"so existing outputs never
   lose their filter"* when a format is later un-promoted

Chips are keyed by `output.id`, labelled by `output.plural`. The whole row — `All` included —
renders only when more than one type exists (`:541`, `:592`).

**"Apps" is `GENERIC_OUTPUT`** (`components/format/formats.ts:59`):

```ts
{ id: 'app', noun: 'App', plural: 'Apps', icon: 'appWindow' }
```

`formatOf()` returns it when a gadget **declares no `output`** (every ordinary gadget) *or* declares
an icon this build does not recognise — deliberate graceful degradation when a deployment serves a
format newer than the browser's cached bundle.

### 4.4 Shipping our own formats

Two routes. **Path A is the plan.**

**A. Promote via `/admin` → Formats.** No code, no redeploy. Chips appear automatically from
`output.id` / `output.plural`. This is the mechanism bundling is a convenience on top of.

**B. Bundle as data.**
`BUNDLED_BLUEPRINTS_DIR=<dir> pnpm import:bundled-blueprint <export.gadget> --new <name>` scaffolds a
blueprint directory (`<export.gadget> <blueprintId>` updates an existing one) and regenerates the
bundled module. Caveats:

- `BUNDLED_BLUEPRINTS_DIR` **replaces** the default set — Docs/Sheets/Slides are lost unless copied
  across. The old `FORMAT_BLUEPRINTS_DIR` name is **no longer read**: a deployment still setting it
  silently builds the default set.
- It resolves against `packages/workshop-backend`, and a tree placed there is bundled but not
  type-checked. Importing over a TypeScript blueprint replaces its sources with the built JavaScript.
- The directory must live in *this* repo, not the submodule; adding files there conflicts on every
  gitlink bump.
- Needs wiring into `buildCommands()` in `scripts/deploy.ts` (same shape as `VITE_CF_ACCESS_MODE`).
- `blueprintId` is the install key. Changing it after deploy promotes a **second** format and
  orphans the first. Rename files freely; never the id.

Planned blueprints: message board, todo list, kanban — Basecamp-5 styled, built in-platform from
`format.document`. Suggested icons: `notebook`/`appWindow`, `listChecks`, `kanban`. Keep `output.id`
generic (`board`, not `veeros-kanban`) since it is the Outputs grouping key.

---

## 5. Theming and CSS

**There is no CSS customization hook** — documented or otherwise. Verified: no
`customCss`/`injectCss`/`themeCss`/`customStyles` anywhere; the frontend's only `VITE_*` variables
are `BACKEND_HOST`, `CF_ACCESS_MODE`, `DEV_AUTO_LOGIN`, `DEV_PASSWORD`, `DEV_USERNAME`,
`FRONTEND_ERROR_REPORTING`; and this repo's `vite.config.ts` is lint-only and explicitly ignores
`cloudflare-os/**`.

The complete admin visual surface is `setSiteName`, `setSiteLogo`, `setAccentColor`,
`setAnnouncement`, `setBanner` (`workshop-backend/src/admin-settings.ts:586`–`633`).

`setAccentColor` is more capable than it sounds: one validated `#rgb`/`#rrggbb` seed expands through
`accentVariables()` (`workshop-shared/src/theme.ts:22`) into `--color-kumo-brand(-hover)`,
`--color-accent-100/200`, `--text-color-kumo-brand`, `--text-color-kumo-link` and
`--color-selection-bg/-text`, set on `document.documentElement`. Kumo's own brand colour therefore
follows it. An empty/invalid value removes them, falling back to `styles.css` defaults (`#ff4801`
light, `#b84e00` dark). The `--color-shadow-accent-*` values are static and do not follow the seed.
It also propagates into sandboxed Gatekeeper UIs via `updateTheme` (`SandboxedGatekeeperApp.tsx:160`).

Everything else is Cloudflare's **Kumo** design system (`bg-kumo-base`, `text-kumo-subtle`,
`border-kumo-line`) with light/dark palettes keyed off `data-mode`. No override hook. The new
`@gadgets/ui` package (#484) is a shared React component layer (currently one `HierarchicalList`),
not a theming hook, and nothing imports it yet.

**Gadget code is unconstrained** — Basecamp-5 styling in our own blueprints is entirely ours. Only
the Workshop chrome is fixed.

---

## 6. Access and permissions

Three independent layers:

| Layer | Granularity | Set by |
|---|---|---|
| Cloudflare Access | Who reaches `os.veer.studio` | Access policy |
| Global tier | **Two only**: admin / everyone else | `access.admins` |
| Per-workspace role | **Three**: owner > build > use | Workspace owner |

No third global tier, no custom roles. Admin is a flat boolean from `ADMINS` (`#isAdmin()`,
`server.ts:121`).

### Per-workspace roles

In code the roles are `build` > `use`, with the owner as the implicit `build` root
(`workshop-backend/src/sharing.ts:33`).

- **`use`** — render and interact with the deployed UI, read `id`/`title`/`owner`/`role`, see
  presence. Everything else throws `Unauthorized`. Default-deny by construction:
  `UseOverseerInterface` (`overseer.ts:12223`) *implements* `Overseer`, so a new method fails to
  compile until someone decides whether `use` may call it.
- **`build`** — full access except: cannot delete (owner only); uses **their own** AI models (BYOK
  bills whoever prompted); uses **their own** connected accounts for bindings.

Effective role is recomputed live from a permission graph at every `open()`
(`authorizeCollaborator`, `overseer.ts:9379`), which for a non-owner also re-verifies them as an
observer of every in-scope gatekeeper. Revocation is lazy — severing an edge is enough — and
removals abort the workspace DO after flushing (`scheduleAccessRestart`, `overseer.ts:6328`), so an
open session dies within ~100 ms rather than lingering.

Two workspace latches can narrow sharing permanently, both set by a gatekeeper observation —
restricted data and owner-invites-only (§8.2). Once owner-invites-only is set, share links can no
longer be created, copied or redeemed, and only the owner can add collaborators.

### What is not possible

**Gadget creation cannot be restricted.** `newGadget()` (`server.ts:319`) has no role check; any
authenticated user can create a workspace. There is no per-user capability flag.

Membership is the lever instead: Access policy decides who reaches the app, and
`setSignupsEnabled(false)` makes a first-time Access-authenticated visitor **rejected** rather than
auto-provisioned (`authenticateFromCfAccess`, `user.ts:437`: *"New sign-ups are currently disabled
on this deployment."*), while existing accounts keep working. Pattern: let each person sign in once
with signups on, then close it.

### User directory and search

New at `ef65348f` (#474). A singleton `UserDirectoryDurableObject` (`user-directory.ts:14`) holds
`{id, name}` for every user, and the share modal can search it:

- **Any authenticated user** can call `searchUsers(query)` (`server.ts:150`): case-insensitive
  substring match on id and display name, 10 results, caller excluded.
- **Results reveal ids — which on an Access deployment are email addresses.**
- The directory fills lazily: a user is added on their next sign-in or display-name change, not by
  a backfill. People who never sign in again never appear.
- Gated by `AdminConfig.userSearchEnabled`, toggled in `/admin` (`setUserSearchEnabled`). While off,
  search returns `[]` and invite-by-exact-email still works. The policy is cached for 30 s per API
  session.
- **The default is a trap.** When the stored config has no value, `normalizeAdminConfig` uses
  `!signupsEnabled` (`admin-config.ts:314`). A deployment that closed signups — ours, per the
  pattern above — therefore gets search **on** at the first request after upgrade. The derived value
  is frozen into storage at the next admin write of any setting.

### Upstream roadmap

`docs/sharing.md` future work (`:187`) lists chat-only and read-only permission levels, resharing
of `use`, binding-aware access control, share-link expiry, un-revoking share links, GC of dead
records, and notifications.

---

## 7. Authentication mechanisms

Three, and `CF_ACCESS_AUD` is a **master switch**, not a preference.

| Method | Where auth happens | Status here |
|---|---|---|
| Cloudflare Access | Before the request reaches the Worker | ✅ Running |
| Built-in password accounts | Inside the Workshop (upstream default) | Refused while Access is on |
| Auth Gatekeepers (OAuth) | Inside the Workshop | Not deployed |

With `CF_ACCESS_AUD` set:

1. Every `/api` request needs a same-origin `Origin` (else 403 *"Cross-origin API access not
   allowed."*) and a valid Access JWT carrying an email (`server.ts:899`–`911`)
2. `login()` and `createAccount()` **throw unconditionally** (`server.ts:778`, `:801`) — password
   auth is refused, not merely hidden
3. `VITE_CF_ACCESS_MODE` is a **build-time constant** (`workshop-frontend/src/useAuth.ts:6`), set by
   our `buildCommands()`. That the login UI is then tree-shaken out of the bundle is expected but
   not verified.

Gatekeeper *sign-in* has no server-side guard but is unreachable in Access mode. A Gatekeeper used
as an ordinary **connector** works fine.

**Identity.** Access and gatekeeper sign-in both key the account by `idFromName(email)`, so switching
between them does not strand data. Password accounts are a separate identity space: they key by a
normalized username (`^[a-z][a-z0-9_]*$`, `user.ts:2120`), which can never be an email.

### Configuring the alternatives

```
AUTH_GATEKEEPERS=cloudflare,google,github   # order = button order
DISABLE_PASSWORD_AUTH=true                  # optional, OAuth-only
```

Only `cloudflare`, `github`, `google` advertise `providesAuth`. `DISABLE_PASSWORD_AUTH` is ignored
unless the allowlist is non-empty — a deliberate anti-lockout guard (`auth/config.ts:30`). OAuth
credentials live as secrets on the **gatekeeper Workers**; redirect URIs are
`https://os.veer.studio/gatekeeper/<vendor>/oauth`. Closing signups also blocks first-time gatekeeper
sign-in.

Sign-in requests minimal scopes and the grant **self-destructs** after the email is read — except
Cloudflare, which requests full scopes and keeps the grant as a connected account
(`server.ts:714`; `auth/login-flow.ts:233`). Completion uses the same ticket-plus-nonce handoff as
connects (§13.3).

**This repo hard-codes Access mode** — no `AUTH_GATEKEEPERS` support exists in `scripts/` or
`deployment.jsonc`. `docs/customization.md:83-84` states both alternatives require deploy script
changes.

---

## 8. The Gatekeeper contract

**`cloudflare-os/packages/workshop-shared/src/gatekeeper.ts`** (1717 lines, ~86 KB), exported as
`@gadgets/workshop-shared/gatekeeper`. This is the whole contract — every Gatekeeper in the repo
implements interfaces declared in this one file. Since `54d5d8b0` much of the *convention* around it
is also library code in `gatekeeper-kit` (connect flows, credentials, OAuth, actions, observations,
simulation); a new Gatekeeper should start there.

### 8.1 The export map

| Export | Line | Role |
|---|---|---|
| `GatekeeperVendor` | 469 | What the Workshop binds — `describe()`, `connectAccount()`, optional `createAccount()` |
| `GatekeeperConnectCallback` | 559 | Connect completion — `complete()` returns a `ConnectHandoff` (464) |
| `GatekeeperUser` | 621 | Per-user surface once connected; includes `commitReconnect(stageId)` (693) |
| `GatekeeperUserVerifier` | 766 | Observer verification |
| `Gatekeeper<Session>` | 775 | The DO holding a connection |

Supporting vocabulary: `VendorDescription` (39), `AccountDescription` (151), `ResourceDescription`
(188), `SupportedResource` (239), `AgentCatalog` (108) with caps at 128–131
(`AGENT_CATALOG_MAX_ENTRIES = 1000`, id 256, title 100, description 400), `ObservationAuthorizer`
(973, now also `getGitCache()` at 997), `ObservationDescription` (1178), `ApprovalQueue` (1063),
`SlashCommandProvider` (1037), `ActionDescription` (1317), `ActionKind` (1305), `ActionField` (1265),
`HookController`/`HookInitiator` (1479, 1505), `GatekeeperUiFrame` (419),
`ResourceConfiguratorIframe`/`Host` (351, 375).

Members added since `08afe059` worth knowing:

| Member | Line | Meaning |
|---|---|---|
| `ActionDescription.fields`, `ObservationDescription.fields` | 1334, 1190 | Typed values (`inline`, `text`, `json`, `list`, `file`) the approver sees literally rather than through Markdown |
| `ActionDescription.descriptionIsComplete` | 1347 | Claim that description + fields reproduce verbatim everything the action writes or sends. Never true for a git push |
| `ObservationDescription.ownerInvitesOnly` | 1235 | Latches the workspace to owner-added collaborators only (§8.2) |
| `getAgentCatalog?()` | 830 | No longer takes an authorizer; a catalog is not an observation |

Authoring guide: `cloudflare-os/.agents/skills/write-gatekeeper/SKILL.md` (345 lines) plus
`SKELETON.md` (638 lines). Agent-facing `types.d.ts` files must now be self-contained — no imports
except `cloudflare:workers` — enforced by the `gadgets/self-contained-agent-types` lint rule (#581,
#582), because they reach the agent as-is and it cannot follow imports. One stale sentence: the
SKILL's observer strategy A (`:248`) says restricted mode "blocks all actions"; the contract
(`gatekeeper.ts:1210`–`1215`) and §8.2 are current.

### 8.2 Sessions and the ApprovalQueue

The ApprovalQueue is not something a session looks up. It is **the argument that creates the
session** (`gatekeeper.ts:815`):

```ts
startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session>;
```

Every channel the session has back to the platform arrives through that one stub. There is no
ambient path.

**The chain, from a binding name in `env` to a row in the audit log** (all `overseer.ts`):

1. **`GatekeeperLoopback`** (`:10422`) — a dynamic isolate's `env` can hold `ServiceStub`s but not
   `RpcStub`s, so each binding is a `WorkerEntrypoint` whose *constructor* opens the session and
   returns a `Proxy` over it. Its own comment calls this a "horrible hack" (`:10411`). Props carry
   `{overseerId, target, caller}`.
2. **`startGatekeeperSession(target, caller)`** (`:5551`) → builds a `GatekeeperClientImpl`, calls
   `openSession()`.
3. **`openSession()`** (`:12919`) first calls `assertGatekeeperUsable` — refusing a connection that
   is pending a scope-widening restart — then:
   ```ts
   return this.facet.startSession(new ApprovalQueueImpl(this.impl, this.id, this.caller));
   ```
4. **`ApprovalQueueImpl`** (`:13013`–`13045`) closes over `{impl, gatekeeperId, caller, hookId?}`
   and forwards four methods: `authorizeObservation`, `getGitCache`, `submitAction`, `bindHook`. A
   queue minted for a hook re-checks that the hook is still live before every call. **The entire
   security value of the object is the fields it closes over** — which gatekeeper, and on whose
   behalf.
5. **`getGatekeeperFacet(id)`** (`:5336`) resolves the gatekeeper as a **Durable Object Facet**
   (`ctx.facets.get('gatekeeper<id>')`) — a child DO of the Overseer, not a separate service.

`GatekeeperCaller` (`:10369`) is the provenance stamped on every record:

```ts
{from:"agent", chatId} | {from:"gadget", chatId?, gadgetId?} | {from:"user", chatId?} | {from:"hook"}
```

#### The three methods behave very differently

| | `authorizeObservation` | `submitAction` | `bindHook` |
|---|---|---|---|
| Blocks on a human? | **never** | never (returns at once) | never |
| Record state | `"approved"` | `"pending"` | `"approved"`, `enabled:false` |
| Can throw? | **yes — `excludeObservers`** | on a removed connection, a restricted git push, or plumbing failure | — |
| Decided later by | — | `applyAction` / `rejectAction` | `enableHook` |

`authorizeObservation` (`:5671`–`5739`) is the one that surprises people: it is **logged, not
gated**. It writes an already-approved audit row (`:5698`) and returns. It throws in one situation:

- **`excludeObservers`** — each opaque observer id is mapped back to a profile; the read is blocked
  if a named observer is still authorized *and* the gatekeeper is within their role's verification
  scope (`:5832`–`5890`). An out-of-scope `use` observer is de-registered from that gatekeeper
  instead; an unauthorized one is torn down.

It can also **latch** the workspace, permanently:

- **`containsRestrictedData`** (`:1159`–`1163`; the storage key is still `"prohibitAllSharing"`).
  Nothing is refused at observe time. From then on the workspace is in **restricted mode** (#487):
  - collaborators are admitted only while verified as observers of the producing gatekeeper,
    re-checked at every `open()`;
  - public web fetches are refused (`getWebFetchEnv`, `:5911`);
  - **nothing auto-approves**, so every action pends for manual approval, and the approver sees the
    full text with a notice that they are responsible for checking it contains no restricted data;
  - **git pushes are refused outright** (`:5970`–`5980`) — "a git push cannot be reviewed as of yet".

  This replaced the original lockdown, under which one restricted observation refused every action.
  The kernel does not restrict *which* connections may be acted on (`gatekeeper.ts:1221`).
- **`ownerInvitesOnly`** (#523, `:5694`). Roles are snapshotted first; anyone who loses access
  (link joiners, transitive collaborators) is restarted out. Share links can no longer be created,
  copied or redeemed, and only the owner can add people. No shipping gatekeeper sets it yet; Google
  BigQuery sets `containsRestrictedData`.

Separately, **`descriptionIsComplete`** (#541) never refuses anything: an incomplete description is
accepted and flagged to the approver on every approval surface.

#### Two independent action-ID spaces

- The **gatekeeper** assigns its own action number (`counter:nextActionId` in its own DO —
  `gatekeeper-homeassistant/src/homeassistant.ts:1420`).
- The **overseer** assigns a separate `actionId` for the audit row (`submitAction`, `:5955`; id at
  `:5991`).
- `applyAction(record.action, gitCache)` passes the **gatekeeper's** number back (`:5380`). The
  overseer's id never crosses the boundary.

This is why every gatekeeper keeps `pending:<id>` rows: the callback carries only an integer, so all
context must be recoverable from local storage.

#### Approve and reject

`applyPendingAction` (`:5374`) is the single chokepoint to `state:"approved"`:

```ts
async applyPendingAction(record, resolvedBy: AiChatAuthorInfo, autoApproved: boolean)
```

`resolvedBy` and `autoApproved` are **required, not defaulted** — a deliberate design note in the
comment: no apply path can omit how the gate was cleared. `approveAction` (`:11158`) resolves the
approver's profile *before* applying, so a failed profile fetch can't leave an action applied in the
world but `"pending"` in storage.

**Auto-approval requires three conditions**, now in one function (`autoApprovalRule`,
`workshop-backend/src/auto-approval.ts:29`–`37`): the gatekeeper author's per-action
`autoApprovable === true`, the workspace's opt-in rule for `${gatekeeperId}:${actionKind.tag}`, and
no restricted-data latch.

`drainAutoApprovals` (`:5403`) applies in ascending id order and **stops at the first non-eligible
pending action** — never skipping ahead of a human gate. `getAutoApprovableActions()`
(`gatekeeper.ts:798`) exists so a pre-approval UI can list what *could* be auto-applied before any
action exists.

#### `awaitDecision`: suspending the agent turn

```ts
// overseer.ts:6024
if (caller.from === "agent" && description.awaitDecision && !willAutoApprove) {
  this.#getOrCreateCapturedActions(caller.chatId).awaitDecision = true;
}
```

`#maybeResumeAfterActionDecision` (`:11263`) walks the chat log back to the turn boundary and
resumes **only if every awaited action in that turn was decided and all were approved**. One denial
leaves the turn ended. On resume it injects: *"The changes you submitted have been approved and
applied: … Reads now reflect them."*

#### Hooks — the fourth caller, with no human present

`bindHook` (`:6034`) stores the controller plus the **persistent** callback stub; persistence is
required because sessions die, explained at length in its doc comment (`gatekeeper.ts:1088`–`1175`).
On `enableHook` the overseer hands the gatekeeper a `GatekeeperHookLoopback` (`:10464`) implementing
`HookInitiator`. At fire time, `startHook` (`:10217`–`10245`) returns:

```ts
{
  callback: makeHookFiringCallback(this.impl, hookId),   // re-validates on every call
  approvalQueue: new ApprovalQueueImpl(this.impl, record.gatekeeperId, {from: "hook"}, hookId),
}
```

A fresh ApprovalQueue materializes for an event nobody triggered. The callback is a proxy that
re-checks the hook on each call rather than the raw stored stub. `startHook` itself re-checks the
hook before and after its storage read, plus the admin's `disabledGatekeepers` list and
`ambientGatekeeperMode === "disabled"`, so disabling takes effect on live hooks.

**Known race, documented upstream** (`TODO(hooks)` in `enableHook`, `:11221`): a concurrent
`disableHook` can land its `controller.disable()` before an in-flight `enable()`, letting the enable
resurrect gatekeeper-side state that keeps consuming alarms and quota until cleaned up. Live firings
stay safe.

#### Flows this architecture supports

1. **Read-only ambient** — Context Library; `applyAction` throws `"read-only and implements no
   actions"` (`gatekeeper-context/src/library-gatekeeper.ts:351`).
2. **Read + queued writes, simulated** — HA, GitHub, Notion, Linear, Google, Spotify, Confluence.
3. **Read + queued writes, not simulated** — Supabase, MCP (both the per-user gatekeeper and the
   portal); both set `awaitDecision: true`.
4. **Auto-approved kinds** — applied without a prompt, still logged with `autoApproved: true` and
   `resolvedBy` = whoever enabled the rule.
5. **Hook-driven** — Scheduler, Slack. Event → `startHook()` → new queue → `authorizeObservation` →
   deliver to gadget.
6. **Slash commands — deliberately attenuated.** `SlashCommandProvider.invoke()` receives a
   `SlashCommandAuthorizerImpl` (`:12940`) implementing *only* `ObservationAuthorizer`
   (`authorizeObservation`, `getGitCache`). It structurally cannot submit actions or bind hooks.
   `getAgentCatalog()` now gets nothing at all — a catalog is a discovery index, not a read.
7. **Restricted mode** — one `containsRestrictedData` observation: verified collaborators only, no
   public web fetches, every action manually approved, no git pushes.
8. **Owner-invites-only** — one `ownerInvitesOnly` observation: direct owner grants only, no share
   links.

### 8.3 "Simulating actions"

The contract *suggests* it (`gatekeeper.ts:808`–`813`):

> It is **suggested** that the gatekeeper "simulate" actions that have not been approved yet […]
> That said, there is **no strict requirement**.

It is a recommendation, and `awaitDecision` is the sanctioned opt-out.

**Why it exists.** `submitAction` returns immediately but the write does not happen — possibly for
days. Without simulation an agent writes, reads back, sees its write missing, and starts
"re-trying, second-guessing, or undoing its own work" (`gatekeeper.ts:1393`).

**How it is implemented — overlay at read time.** Home Assistant is the reference. Nothing is ever
mutated; pending actions are folded over real state on each read.

Write path (`submitWrite`, `homeassistant.ts:1319`–`1352`, simplified) — store first, submit second,
roll back the row if submit fails. Between the two it fetches the entity registry to describe the
action:

```ts
const id = self.#nextActionId();
self.ctx.storage.kv.put<PendingActionRow>(`pending:${id}`, { id, action, submittedAt: Date.now() });
try {
  await approvalQueue.submitAction(id, describeAction(action, registry));
} catch (e) {
  self.#deletePending(id);   // queue stub gone — don't leave a phantom
  throw e;
}
```

Read path (`getState()`, `homeassistant.ts:2748`) — note the short-circuit that keeps the common case
at one round-trip:

```ts
const pending = this.#ctx.listPendingActions();
if (pending.length === 0) {
  raw = await callApi(this.#ctx, r => r.getState(this.#entityId));   // one REST call
} else {
  const [rawState, registry] = await Promise.all([...]);             // registry needed to resolve targets
  const result = overlayEntityState(rawState, pending, registry);
  raw = result.state;
  appliedCount = result.appliedCount;
}
await this.#ctx.approvalQueue.authorizeObservation({
  title: `Read entity state`,
  description: `Read state of \`${this.#entityId}\` (current: ${state.state})` +
      pendingSuffix(appliedCount) + `.`,
});
```

`pendingSuffix(appliedCount)` is the honest part: **the approver is told how much of what the agent
read was imaginary.**

`overlayEntityState` (`simulation.ts:328`) is a pure fold; `applyServiceToState` (`simulation.ts:69`)
is a `switch` over `${domain}.${service}` that **returns the input unchanged for anything it does not
recognise** — scripts, scenes, templates, custom integrations. `indexPendingByEntity`
(`simulation.ts:303`) makes a list read O(actions-for-that-entity) instead of O(all-actions) per row.

**GitHub goes further: provisional IDs** (`gatekeeper-github/storage-schema.md:9`, `~1`, `~2`, …).
Creates synthesize a local issue/PR object until GitHub assigns a real one; rejecting a provisional
create deletes dependent pending actions and returns `restart: true` (`github.ts:4053`; a rejected
push cascades to dependent PRs at `:4065`).

That is the cost of simulation, made explicit. HA can reject silently because its overlay is
*derived* from `pending:*` — delete the row and the simulation evaporates. GitHub cannot: the gadget
holds a provisional number that will never exist, so the gadget must restart. Six gatekeeper
packages (GitHub, Notion, Linear, Google incl. Gmail, Confluence, Spotify) return `{restart: true}`
on some rejection path.

**The opt-out, stated plainly in both places:**

```ts
// gatekeeper-supabase/src/supabase.ts:950
// This gatekeeper doesn't simulate writes, so the agent shouldn't continue (and read back
// un-applied state) until the user decides on this statement.
awaitDecision: true,
```

```ts
// mcp-shared/src/session.ts:223
// Nothing about a queued call is simulated, so later reads would show a world in which it
// never happened. Wait for the decision instead.
awaitDecision: true,
```

Both are right: arbitrary SQL and arbitrary MCP tool calls have no predictable effect to model. MCP
additionally returns a `status: "pending"` sentinel telling the agent to return from `executeCode` so
the approval card can render (`session.ts:237`).

> **Design rule if we build one:** simulate ⟺ leave `awaitDecision` unset. Getting this backwards is
> the real failure mode — a gatekeeper that neither simulates nor awaits will make agents thrash.

**`gatekeeper-kit` now encodes the rule.** Every `ActionDefinition` must declare `delivery:
"continue-with-simulation" | "await-decision"` (`gatekeeper-kit/src/actions.ts:144`), and the kit
sets `awaitDecision` from it. The kit also ships `createSimulationView`, `replaySimulation` and
`ProvisionalIds` (`gatekeeper-kit/src/simulation.ts`). Descriptions should come from its
`ActionDescriptionBuilder` / `buildDescription()` (`gatekeeper-kit/src/action-description.ts`), which
emits `fields` and sets `descriptionIsComplete` only when nothing was truncated. `USAGE.md:544`–`570`:
never set `descriptionIsComplete` by hand, and never put agent- or provider-supplied text in the prose.

### 8.4 Singleton gatekeepers and ambient capsules

**The name misleads.** It is not a Durable-Object singleton. It means: *an account that provides one
always-present gatekeeper, installed into every one of the owner's gadgets automatically, with no
binding step.* The resulting object is called an **ambient capsule**.

Declared in two places (`gatekeeper-context/src/library-gatekeeper.ts:382` and `:135`):

```ts
autoProvisionsAccount: true,                    // VendorDescription — mint accounts with no OAuth
singleton: { tsType: "ContextLibrary" },        // AccountDescription — provides an ambient capsule
```

| | Ordinary gatekeeper | Singleton |
|---|---|---|
| Account created by | OAuth via `connectAccount()` | `createAccount()` — no flow, no user identity |
| Class obtained from | `getGatekeeperClassFor(url)` (user pastes a URL) | `getSingletonGatekeeperClass()` |
| Enters a gadget via | Explicit binding, user-named | `ensureAmbientCapsules()` on `open()`, **unnamed** record, `creationSpec: {type:"ambient"}` |
| Agent sees it as | A named binding in `env` | Auto-provided capsule, named at chat-seed time from `describe().suggestedBindingName` |
| `getSupportedResources()` | Non-empty | `[]` — an empty list hides the vendor entirely |
| `reconnect()` | Re-runs OAuth | Throws |
| Scope | One resource | Broad — hence `getAgentCatalog()` |
| Count | Many per workspace | One per user |

**Everything else is identical.** `ContextGatekeeper` is a plain `DurableObject implements
Gatekeeper<LibraryReadSession>` installed as a facet like any other, with the same ApprovalQueue and
the same per-read `authorizeObservation`. The contract says so outright (`gatekeeper.ts:728`–`734`):

> Because it is a normal Gatekeeper, the session and catalog run gadget-side in the gatekeeper's own
> worker with no round-trip back through this account DO; every session read is still authorized as
> an observation via the ApprovalQueue, exactly like any gatekeeper.

**Provisioning is a reconciliation, not a one-shot install** (`ensureAmbientCapsules`,
`overseer.ts:7556`), run on every workspace open:

```ts
let accounts = (await ownerDo.listProvidedAccounts())
    .filter(account => account.description.singleton?.tsType);

// Records key on (vendorId, accountId). If the account is gone, or was removed and re-added with a
// new accountId, the record points at a deleted account — drop it.
for (let gk of existingGatekeepers) {
  if (gk.creationSpec?.type !== "ambient") continue;
  if (currentAccountId.get(gk.creationSpec.vendorId) === gk.creationSpec.accountId) bound.add(...);
  else this.removeGatekeeper(gk.id);
}
```

Two properties worth copying: provisioning is **per-account isolated** in a `try/catch` (one
gatekeeper whose `getSingletonGatekeeperClass` throws must not block `open()` for the whole
workspace), and it runs under `Promise.all` so Cap'n Web batches the class lookups
(`:7590`–`7606`).

The encapsulation note at `overseer.ts:7583` is the important one: **only the class reference crosses
out of the owner's user DO.** The account capability itself never leaves.

**Broad scope forces more observer machinery.** `addObserver` cannot be the usual "can this user read
the resource?" check, so Context tracks the collections actually revealed and verifies every observer
against each one (`ContextObserverTracker`, `gatekeeper-context/src/context-observers.ts:25`; used from
`addObserver`, `library-gatekeeper.ts:339`). Note `GatekeeperUserVerifier` has **no methods** in the
contract (`gatekeeper.ts:766`) — the convention is to add a non-standard method and trust the answer,
because the overseer only ever hands a verifier back to the vendor that minted it.

**Reference implementation:**
`cloudflare-os/packages/integration-tests/fixtures/gatekeeper-test/src/test-gatekeeper.ts` — vendor,
account, verifier and gatekeeper, with `singleton` and no `providesUi`. At 765 lines it is no longer
minimal (it grew test controls, hooks and a response recorder); read `describe()` and the class
wiring, skip the rest.

### 8.5 Management UIs (`providesUi`)

**`providesUi` and `singleton` are independent.** Two separate optional fields on the same type
(`gatekeeper.ts:173`–`184`); neither implies the other. The listing gate is an **OR**, over *all*
connected accounts, with no `autoProvisioned` requirement in the inclusion test
(`workshop-backend/src/user.ts:1498`):

```ts
for (let rec of this.#connectedAccountRecords()) {
  if (!rec.description.singleton && !rec.description.providesUi) continue;
  if (rec.autoProvisioned && ambientGatekeeperMode(config, rec.vendorId) === "disabled") continue;
  ...
}
```

All four combinations are structurally legal:

| `singleton` | `providesUi` | Example |
|---|---|---|
| ✓ | ✓ | Context Library (`library-gatekeeper.ts:135`–`136`) |
| ✓ | ✗ | the integration-test fixture (`test-gatekeeper.ts:326`) |
| ✗ | ✓ | nothing ships this, but it is supported |
| ✗ | ✗ | every ordinary OAuth gatekeeper |

**The real constraint is routing, not the flags.** The app id is the **vendorId**, not the account id
(`workshop-backend/src/server.ts:621`; rationale comment at `:598`):

```ts
// UI-providing accounts are auto-provisioned singletons (one per vendor), so the vendor id
// identifies them.
let app = accounts.find(a => a.vendorId === id && a.description.providesUi);
```

`find` — first match wins, so a vendor with several UI-declaring accounts would have all but one
unreachable at `/gatekeepers/<vendorId>`. That is why the contract (`gatekeeper.ts:722`) says these
methods are "Present only on accounts created by `GatekeeperVendor.createAccount()`": one account per
vendor per user is what makes vendor-id routing sound. A latent assumption, not an enforced check.

> **Upshot: `providesUi` needs `autoProvisionsAccount`, not `singleton`.** A UI-only gatekeeper — an
> invoices page with no agent surface at all — is a legal and clean configuration.

#### The UI calls the gatekeeper directly

`startAppUi` returns an **arbitrary gatekeeper-defined capability** (`gatekeeper.ts:419`):

```ts
export type GatekeeperUiFrame = {
  iframeHtml: string;
  ui: RpcStub<RpcTarget>;   // "Capability exposed to the iframe for any RPCs needed by the UI."
}
```

Context mints it inside the account (`library-gatekeeper.ts:147`):

```ts
async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
  let ui = new RpcStub(new ContextApiImpl(
    this.env, this.ctx.props.sharingDomain, this.ctx.props.accountId, context.isAdmin,
    this.#collections(), this.#userLibraries(), this.#registries()));
  return { iframeHtml: APP_HTML, ui };
}
```

`ContextApiImpl` holds the DO namespaces directly. **There is no Overseer, no facet, no gadget, no
`ApprovalQueue` and no `ObservationAuthorizer` anywhere in this path.** The same gatekeeper exposes
two very different surfaces:

| | Agent / gadget path | App UI path |
|---|---|---|
| Entry | `ContextGatekeeper.startSession(approvalQueue)` | `ContextAccount.startAppUi(context)` |
| Runs as | DO Facet under the Overseer | plain `RpcTarget` in the gatekeeper's worker |
| Every read | `authorizeObservation()` → audit row | nothing |
| Every write | `submitAction()` → approval queue | executed immediately |
| Operations | `search` / `list` / `read` | `createContextCollection`, `updateContextCollection`, `putContextDocument`, `deleteContextDocument`, `moveContextDocument`, `deleteContextCollection`, `syncContextCollectionArtifactSource`, git-token create/list/revoke |

The agent gets a read-only session that logs everything; the human gets full CRUD that logs nothing.
That asymmetry is deliberate: **the approval queue governs the agent acting on your behalf, not you
acting with your own hands.** Prompting for approval of your own clicks would be nonsense.

**Transport.** `getGatekeeperApp` → `GatekeeperAppPage` → `SandboxedGatekeeperApp`:
`sandbox="allow-scripts allow-modals"` (`SandboxedGatekeeperApp.tsx:369`; no `allow-same-origin` →
null origin, network-isolated), and capnweb `newMessagePortRpcSession(port, host)`. Workshop relays
`ui` through a rate limiter rather than handing it over raw (`:106`–`111`): `maxConcurrency: 8`,
`maxCallsPerMinute: 600`, `maxPendingCalls: 128`, throttle. The stub is a live server-side capability,
released on unmount via `disposeFrame`.

#### Four consequences to design around

1. **We own authorization completely.** Nothing upstream checks anything beyond "this user holds this
   account." Context does its own: `#assertCanRead` / `#assertCanWrite` / `#assertAdmin`
   (`context-api.ts:89`, `:100`, `:116`).
2. **The only identity signal is `isAdmin`** — no user id, no email (`AppUiContext`,
   `gatekeeper.ts:86`), passed fresh per open precisely because admin status changes. Per-user
   scoping must come from the account's own props, as Context does with `accountId`.
3. **Nothing in this path is audited.** Deleting a collection through the UI leaves no trace in the
   workspace action log. An audit trail for the human path is ours to build.
4. **The `ui` surface *is* the attack surface.** The iframe cannot reach the network; the capability
   is its only exit. Mint the narrowest object that works, never an internal API.

Same mechanism, incidentally, as the small connect-modal form: `ResourceConfiguratorFrame` is a
literal alias for `GatekeeperUiFrame` (`gatekeeper.ts:431`).

### 8.6 Packaging note

Three submodule packages are members of **this** repo's pnpm workspace: `workshop-shared`,
`error-reporting`, and the build tooling `cloudflare-os/scripts` (`@gadgets/scripts`, needed because
`error-reporting` depends on it). That is what lets `packages/custom-gatekeeper` import the contract
via a plain `workspace:*` dependency with no submodule changes.

The cost: every `catalog:` specifier those packages declare resolves against *our*
`pnpm-workspace.yaml`, which must mirror the submodule's entries byte-for-byte. A missing entry fails
`pnpm install` loudly (§13.2: `typescript6`, `zod`); a stale one is silent — two copies of `capnweb`,
and a stub minted by one is unserialisable by the other.

---

## 9. Gatekeeper survey

### 9.1 Anatomy, via Slack

`getTypeScriptTypes()` returns a bundled `types.txt` — heavily commented TypeScript declarations that
become **the agent's documentation** for the API. That file is the product surface.

The central pattern is **resources ↔ scopes** (`gatekeeper-slack/src/slack.ts:113`–`157`):

```
WORKSPACE     https://*                                               → team:read, channels:*, groups:*, im:*, mpim:*, search:read
CONVERSATION  https://app.slack.com/client/:teamId/:conversationId    → channels:*, groups:*, im:*, mpim:*, search:read
THREAD        https://*.slack.com/archives/:conversationId/:messageId → *:history only
```

- `resourceUrlPatternsToScopes()` requests only the scopes for what is being granted, plus an
  always-present identity scope (`users:read`)
- `grantedResourcesFromScopes()` exposes a resource only when **every** required scope was granted —
  a partial grant hides it rather than half-working

Slack is **read-only** (no `chat:write` anywhere). Its agent API is three interfaces —
`SlackWorkspaceSession`, `SlackConversation`, `SlackThread` — with all listings returning
forward-only `Cursor<T>`.

### 9.2 `gatekeeper-mcp` vs `gatekeeper-mcp-portal`

| | `gatekeeper-mcp` (ours) | `gatekeeper-mcp-portal` |
|---|---|---|
| Server URL | **Each user types one** | **Admin sets one** (`MCP_PORTAL_URL`) |
| Scope | Per-user | Per-deployment |
| Unconfigured | n/a | Advertises no resources → Workshop hides it |
| Trust | *"A user-supplied endpoint vouches only for itself"* (`mcp.ts:76`) | Behind Access + Gateway |

Both gate writes: `readOnlyHint` on each MCP tool decides observation vs approval-gated action
(`mcp-shared/src/tools.ts:62`–`91`). Auto-approval additionally requires `trust === "vetted"`, so in
`gatekeeper-mcp` tool annotations **never** earn it, precisely because the user supplied the endpoint.

The portal's config validation is a good pattern (`gatekeeper-mcp-portal/src/config.ts:62`–`88`):
HTTPS-only, `hash` stripped, and **URL userinfo rejected outright** rather than silently stripped,
since silently stripping would contact a different endpoint than the administrator configured.

### 9.3 `gatekeeper-cloudflare`

Three capabilities: **sign-in** (`providesAuth: true`; unusually, it keeps a full-scope grant — §7);
**AI Gateway BYOK billing** via `CloudflareGatekeeperUser.getUsableAccessToken()` — a contract
extension marked *"Workshop-only — never exposed to gadgets or agents"*; and **Workers
Observability** (account-level and per-Worker logs, invocations, traces, metrics).

That last one would let an agent inspect this deployment's own Worker logs — worth considering while
the Error Reporter is disabled.

Since #555 it refreshes tokens through `gatekeeper-kit`'s OAuth client, and a failed refresh marks the
account expired **only on grant death** — `invalid_grant`, or another OAuth error code on a 4xx other
than 429, excluding `invalid_client` (`cloudflare.ts:360`–`410`). 5xx, 429, WAF challenges, timeouts
and malformed responses keep serving the cached token while it is valid, instead of hiding the
account and demanding a reconnect that fixes nothing.

### 9.4 Building `gatekeeper-basecamp5` or `gatekeeper-telegram`

**Basecamp 5 maps cleanly.** Real OAuth 2, and unusually regular URLs
(`https://3.basecamp.com/:accountId/buckets/:projectId/...`) that fit the resource-pattern model.
Its uniform "Recording" abstraction suits `resolveRequestedResource`. Two things to plan for:
Basecamp's OAuth is **coarse** — effectively all-or-nothing per account — so
`grantedResourcesFromScopes()` has nothing to filter on and granularity must be enforced *inside* the
Gatekeeper; and it is read+write, so mutations must be `ActionDescription`s behind the approval
queue.

Start from `gatekeeper-kit` rather than a copy of Slack: `OAuthClient` + `oauthRefresh` for the token
endpoint (manual redirects, capped bodies, timeouts, RFC 7009 revoke, PKCE), `CredentialCoordinator`
for serialized refresh, `ActionDescriptionBuilder` for approval text, and `delivery` per action
(§8.3). Implement the connect handoff (`complete()` → `ConnectHandoff`, `reconnectComplete()`,
`commitReconnect()`; §13.3) and set `BASE_URL` (§1.2).

**Telegram is a design problem first.** The Bot API uses a bot token, not OAuth, so `connectAccount`
resembles MCP's connect form. More seriously it is **update-driven**: there is no "fetch this
channel's history" call, and group privacy mode limits a bot to messages addressed to it. A
Slack-style `listMessages()` over past conversation has no equivalent — either the Gatekeeper
durably accumulates messages from the moment it connects, or the design moves to MTProto with a real
user account. Inbound delivery is where `HookController`/`HookInitiator` and
`external-message-gateway.ts` come in. Scope the history question before writing code.

### 9.5 `gatekeeper-email` — the Gatekeeper that *is* the service

Structurally the odd one out, and the most instructive for anything we build on Cloudflare
primitives. Every other Gatekeeper is a **client** of an external API. This one is a **server**: mail
from the public internet enters the platform through it. All `email.ts` references are
`packages/gatekeeper-email/src/email.ts`.

#### Two entry points

The default export carries a second handler (`email.ts:155`–`240`):

```ts
export default {
  async fetch(req, env, ctx)  { ... },   // connect-flow completion URL only
  async email(message, env, ctx) { ... } // inbound SMTP, via Cloudflare Email Routing
};
```

The router carries a matching one (`packages/router/src/index.ts:62`):

```ts
async email(message, env) {
  if (!env.GATEKEEPER_EMAIL) {
    message.setReject("No email gatekeeper is installed on this instance.");
    return;
  }
  await env.GATEKEEPER_EMAIL.email(message);
}
```

with `GATEKEEPER_EMAIL?: Service<EmailEntrypoint>` marked *"Dormant until custom domains + Email
Routing exist; the handler ships anyway."* Email Routing may target either worker; pointing it at the
router keeps one worker owning the origin.

#### No OAuth, no credentials

There is no third party to authorize against, so `connectAccount` (`email.ts:265`) mints a nonce URL
served by its *own* `fetch()`, and clicking it **is** the authorization. All the security is in the
nonce: 32 bytes, `crypto.subtle.timingSafeEqual`, 10-minute expiry, and a 1-hour self-destruct alarm
on the `UserAccount` DO if the flow is abandoned. Nothing expires afterwards; `reconnect()` throws.

#### The namespace problem — the transferable part

Owning the service means owning a **global namespace** (mailbox local parts) that no external system
arbitrates. The solution: **the DO name *is* the address.**

```ts
let stub = ctx.exports.EmailAddress.getByName(name);   // local part → DO
```

Uniqueness comes free from Durable Object naming. Ownership is then one KV key (`email.ts:626`):

```ts
async claim(userAccountId: string): Promise<boolean> {
  let owner = this.ctx.storage.kv.get<string>("owner");
  if (owner && owner !== userAccountId) throw new Error("This email address is claimed by another user");
  if (!owner) { this.ctx.storage.kv.put("owner", userAccountId); return true; }
  return false;   // idempotent for the same owner
}
```

Three details make it correct rather than merely working:

- **Claims are permanent.** `revoke()` disconnects every hook but explicitly does *not* release
  claims — `// ... they are permanent.` (`:436`). Right call: releasing an address would let a later
  user receive mail intended for an earlier one.
- **Two-phase with conditional rollback** (`email.ts:423`) — `EmailAddress` is the source of truth,
  `UserAccount` the index, and the compensation is gated on `newlyClaimed` so a retry cannot release
  a pre-existing claim:
  ```ts
  let newlyClaimed = await emailAddress.claim(userAccountId);
  try { await userAccount.addEmail(emailName); }
  catch (error) { if (newlyClaimed) await emailAddress.releaseClaimAndHook(userAccountId); throw error; }
  ```
- **Canonicalization enforced twice** — `validateEmailName` lowercases and regex-checks, then the URL
  is re-encoded and compared (`:411`): `if (emailNameSegment !== encodeURIComponent(validated.emailName)) throw`.
  Without that second check, `Foo`, `foo` and `%66oo` would be three URLs claiming one mailbox.

> **Generalizable:** any Gatekeeper that *is* the service inherits a namespace-allocation problem the
> client-style ones never face. A Basecamp or Telegram Gatekeeper is a client and skips this
> entirely; a media, webhook-receiver or SMS Gatekeeper inherits it in full.

#### The canonical hook implementation

`write-gatekeeper/SKILL.md:303` names it outright: *"`gatekeeper-email` is the canonical reference
implementation"* for hooks. Seen from the Gatekeeper side, the loop from
[§8.2](#82-sessions-and-the-approvalqueue) is:

1. **Register** — `subscribe(callback)` (`email.ts:505`) builds the controller *at bind time* so its
   props capture this registration, then hands both to the overseer. It never stores the callback.
2. **Enable** — `controller.enable(initiator, _target)` (`:596`) → initiator persisted in the
   `EmailAddress` DO under `"hook"`. `_target` is unused; since capnweb-validate 0.3.0 extra
   arguments to a validated method are **dropped** rather than rejected, so declaring it is no longer
   required (`:590`–`594`).
3. **Deliver** — `receiveEmail` (`email.ts:661`) is worth reading closely:
   ```ts
   using startHookResult = hookInitiator.startHook();     // no await
   await startHookResult.approvalQueue.authorizeObservation({ ... });
   await startHookResult.callback.receiveEmail(email);
   ```
   That is **promise pipelining** — a property access on an unresolved promise, collapsed by Cap'n
   Web into one round trip. `using` disposes the result and every stub inside it.
4. **Disable** — `#setHook(null)`.

`startSession` calls `approvalQueue.dup()`, per the SKILL tip (`:328`): Cap'n Web auto-disposes stubs
passed as RPC parameters when the call returns, so anything outliving the call must be duplicated.

#### Observers: the "low-stakes" strategy, and why it is legitimate *here*

`addObserver` / `removeObserver` are no-ops and `EmailVerifier.verify()` is empty — strategy D in
`docs/observers.md`, "low-stakes" in the source. The justification (`email.ts:577`–`581`):

> Each mailbox is a fresh address minted on the deployment's own domain for this Gadget; there is no
> external ACL and no other party who "independently has access" to that inbox, so the Gadget's own
> collaborators are the natural audience.

**That reasoning is available only because it is the service.** A Gmail Gatekeeper must use strategy
A (always throw) — a real personal inbox can never be shared. Here the inbox was conjured for the
gadget, so gadget collaborators *are* the correct ACL.

Every inbound email is logged as an observation carrying **sender, subject, date, to, cc — but not
the body or attachments**, which go straight to the gadget. The audit log records *that* mail arrived
and from whom, never its content.

#### Receive-only, and two sharp edges

`applyAction` throws, `rejectAction` no-ops, `revertAction` throws, `getAutoApprovableActions()`
returns `[]`. Nothing is ever submitted to the queue.

- **`SupportedResource.description` says "Send and receive emails."** (`:82`). There is no send path
  anywhere in the package. An agent reading the resource catalog could reasonably believe outbound
  mail works.
- **Unbound mailboxes bounce, and leak the error.** `receiveEmail` throws when no hook is configured,
  and the handler calls `message.setReject("Delivery failed: " + err)` (`:238`) — bouncing is right,
  but the raw error text reaches the sender.

#### Deployability for `os.veer.studio`

It ships in every release but is excluded from the hosted deploy app
(`scripts/release/manifest-lib.ts:268`):

```ts
// Not installable on customer instances: Email Routing needs a zone, which workers.dev-hosted
// instances don't have. The bundle still ships in the release so the entry stays auditable.
const NOT_INSTALLABLE = new Set(["gatekeeper-email"]);
```

**That blocker does not apply to us** — `veer.studio` is a real zone with the router already on it.
It is now wired in this wrapper — a row in the vendor-Gatekeeper table, `GATEKEEPER_EMAIL` on both
binding lists, a build step, and a derived `BASE_URL` (§1.6) — but `email.enabled: false` until the
Email Routing rules are decided. Still outside the wrapper: the Email Routing DNS and rules on the
zone.

`BASE_URL` matters more here than for MCP. It is simultaneously the resource-URL namespace *and* the
fetch-handler path prefix, and `getGatekeeperClassFor` rejects any URL whose origin does not match
(`:387`). Left unset it falls back to `http://localhost:8787/gatekeeper/email` and **no mailbox can
ever be bound** — a harder failure than MCP's broken callback.

One further gotcha, admitted in the source (`email.ts:92`–`97`):

```ts
// TODO: This is actually a lie, as email routing can be configured on an entirely different
//   domain and forwarded to this worker. We only really care about the name before the `@`...
function getEmailHost(env: Env) { return new URL(getBaseUrl(env)).hostname; }
```

With `BASE_URL=https://os.veer.studio/gatekeeper/email` and routing on `*@veer.studio`,
`getAddress()` reports `foo@os.veer.studio` while the working address is `foo@veer.studio`. Routing
still succeeds (only the local part is used), but every address shown to the UI and the agent is
wrong.

---

## 10. Credentials and secrets

**Gadgets cannot hold secrets.** There is no gadget secret store and no API to set one. A gadget
holds a *binding* to a Gatekeeper that holds the credential.

| Layer | Mechanism |
|---|---|
| Deployment secrets | Wrangler secrets on the **consuming Worker** (e.g. `CLIENT_SECRET` on the gatekeeper Worker, never the backend) |
| User OAuth tokens | The Gatekeeper's own DO (Slack's `UserAccount`) |
| Delegated tokens | **Minted, not stored** — Context git tokens come from `repo.createToken("write", TTL)`; the Gatekeeper never holds them |
| Privileged reads | Marked explicitly — `getUsableAccessToken()` is Workshop-only; `user.ts:855` carries `/** DO NOT MAKE PUBLIC -- returns API keys. */` |

Two implementation details worth copying:

- Slack serializes credential mutations through a promise chain because *"rotating refresh tokens are
  single-use"* (`slack.ts:318`) — concurrent refresh/revoke against a rotating token is a real
  corruption bug. `gatekeeper-kit`'s `CredentialCoordinator` is now the reusable form of this; Slack
  itself still hand-rolls it.
- `listGitTokens` filters to **active write** tokens only (`context-collection.ts:497`); the DO mints
  its own read tokens for cloning and deliberately does not expose them.
  `GIT_TOKEN_TTL_SECONDS = 31_536_000` (1 year).

### The sharp edge

Blueprints exclude credentials — enforced. But `docs/sharing.md:144` says *"the full `AiModelConfig`
**including API key** is stored in the binding props"*, and the code confirms it (`overseer.ts:11057`).
Since #572 that config can also carry `extraHeaders` — e.g. a `cf-access-token` for a gateway behind
Access, which may be the only credential when `apiToken` is empty. Those headers sit in the same props.

We found no client or agent path that returns those props — `describe()` exposes only provider, model
and display name, and the client gets a `RedactedAiModelConfig`. The concrete exposure is therefore
*use*: a `build` collaborator can run the binding, and it bills its creator. The credential still
lives in a shared gadget's storage.

> **Never add a BYOK AI model binding to a gadget shared with clients.** Let each collaborator add
> their own — that is already the platform's grain, and it bills them.

### Condensed practice

1. Credentials belong to a **Gatekeeper**, never a gadget
2. Deployment secrets → Wrangler secrets on the Worker that consumes them
3. Prefer **minting short-lived scoped tokens** over storing long-lived ones
4. **Serialize** credential mutations when refresh tokens rotate — use `CredentialCoordinator`
5. Sign-in should use **minimal scopes with a transient grant**
6. Treat **binding props — API keys and model headers — as held by the gadget**
7. Never put a credential in `customGatekeeper.message`, a Context document, or a `SKILL.md` — all
   three are agent-readable, and Context documents are searchable

---

## 11. Design sketches

*Exploratory. Nothing built.*

### 11.1 Client portal and billing

#### The reframe

Replacing Access with a `veer-clients-gatekeeper` is feasible — identity stays keyed by verified
email, so no accounts move — but the cost is concentrated: **unauthenticated requests would start
reaching application code**, and we would inherit sessions, token rotation, recovery and MFA that
Access provides today (including one-time PIN, which already lets external clients sign in with just
an email).

**The portal does not need to be the auth mechanism.** A Gatekeeper works fine in Access mode as an
ordinary connector — only gatekeeper *sign-in* is unreachable. Keep Access as the outer door; build
the commercial layer as an ambient Gatekeeper.

#### Where the portal lives

Two independent flags on `AccountDescription` (`gatekeeper.ts:173`–`184`) — see
[§8.5](#85-management-uis-providesui) for the full mechanics:

```ts
singleton?: { tsType: string };                       // an ambient agent capsule
providesUi?: { title: string; icon?: AvatarImage };   // a full-page management UI
```

`providesUi` yields `startAccountAppUi(accountId, { isAdmin })` → a `GatekeeperUiFrame`: a full-page
app in a sandboxed iframe, with `isAdmin` supplied fresh per open. That is a customer-portal surface.
Mark the Gatekeeper auto-provisioned and every user gets it without connecting.

Three findings from §8.5 shape the design here:

- **The portal does not need `singleton`.** `providesUi` requires `autoProvisionsAccount` (one
  account per vendor, because routing keys on vendor id), not an agent capsule. An invoices page with
  no agent surface at all is a legal configuration — worth considering for v1.
- **The UI path bypasses the approval queue entirely.** The `ui` capability is minted inside the
  account and reaches the iframe over a MessagePort with no Overseer, no `ApprovalQueue` and no
  `ObservationAuthorizer` in between. Clients reading their own invoices get zero approval friction —
  which is what we want — but it also means **we own authorization and audit in that path
  completely.** For billing, an audit trail is not optional, and nothing upstream will write it.
- **The only identity signal is `isAdmin`** — no user id, no email. Per-client scoping has to come
  from the account's own props (`accountId`), the way Context does it.

#### The gap: no metering primitive

- `PRODUCT_ANALYTICS` is an **optional Pipeline binding, not bound** in the base config nor by this
  repo. Its events are lifecycle-shaped (`account_created`, `gadget_created`, `connection_created`,
  `user_authenticated`, …) — no per-call events, no token counts, no cost.
- **Observations are not a ledger** — they are the access-control mechanism.

Nothing counts "client X made 400 calls through gatekeeper Y." **Metering must live in our own
Gatekeepers.**

#### The reference implementation

`docs/ai-gateway-billing.md` is the shape, already in-tree:

- Per-user counters on the user's own DO — `consumeDailyLlmCall(limit)` is an atomic check-and-count
  where `withinLimits` is the *pre-count* decision and it no-ops once exhausted, so a blocked request
  never counts
- A gate before each billable action (`checkUsageAndBalance`)
- Live balance from an external billing API, cached 5 minutes
- And the design rule, stated outright: **"the platform never holds money"**

#### Proposed shape

1. **`veeros-gk-billing`** — auto-provisioned with `providesUi`; owns a `ClientAccount` DO per user
   and renders the portal. Add `singleton` only if an *agent* should be able to query balances;
   the human portal does not need it.
2. **Metering by convention** — each veer-owned Gatekeeper holds a service binding to it and calls
   `recordUsage(vendorId, unit, qty)`. The invoice is unified because all our Gatekeepers report to
   one ledger, not because the platform unified anything
3. **Invoicing** — hold no money; push line items to Stripe and render its state
4. **Enforcement** — a `checkUsageAndBalance` analogue at the top of each call

#### Constraints

- **Everything is per-user, not per-org.** No organization concept exists; "client = company with
  three seats" is a mapping we maintain.
- **"Who pays" is already opinionated** — BYOK bills whoever prompted; bindings resolve to their
  creator.
- **We can only meter our own Gatekeepers.** Context, Scheduler and MCP do not report to us without
  patching the submodule.
- **Metering sits on the trust boundary** — decide deliberately whether a failed `recordUsage`
  blocks the call or is fire-and-forget. That choice is either a revenue leak or an outage.
- **A charge cannot be honestly simulated.** Any agent-initiated billable action must use
  `delivery: "await-decision"` and leave `autoApprovable` unset (see
  [§8.3](#83-simulating-actions)), with the amount and payee as `fields` so the approver sees them
  literally. The human portal path is unaffected — it never touches the queue.

### 11.2 Media service on R2

*Exploratory. Nothing built. The premise — a media service built the way `gatekeeper-email` is built
— is sound, and the platform fit is unusually good.*

#### The shape: Email's posture, Context's storage

It is a hybrid of the two Gatekeepers we now understand best:

| Borrowed from | What |
|---|---|
| [`gatekeeper-email`](#95-gatekeeper-email--the-gatekeeper-that-is-the-service) | *Being* the service: owns a public HTTP surface, owns a namespace, no OAuth, claim-based ownership |
| [`gatekeeper-context`](#3-context-gatekeeper) | Collections with public/private visibility, `providesUi` file manager, ambient `singleton` for agent read |

R2 supplies durable object storage; Cloudflare Images (`/cdn-cgi/image/…`) and Stream supply the
transforms. Both require a zone — **the same constraint that makes `gatekeeper-email`
`NOT_INSTALLABLE`, and one we satisfy.**

#### Verified: no in-tree precedent for serving bytes

Every existing Gatekeeper `fetch()` handler is an OAuth callback, a connect-nonce or handoff page, an
MCP transport, or a status string. Context does **not** serve git itself — the platform `ARTIFACTS`
binding does, and Context merely mints scoped credentials against it (`artifact-sync.ts:225`):

```ts
let token = await repo.createToken("read", 3600);   // short-lived, per-operation
```

So a media Gatekeeper serving public bytes would be the **first of its kind in this codebase**. The
mechanism already exists: the router forwards `/gatekeeper/<suffix>/*` to whichever `GATEKEEPER_*`
service is bound (`router/src/index.ts:28`–`35`), so `https://os.veer.studio/gatekeeper/media/...`
needs no router change — only a binding.

`ARTIFACTS`' short-lived scoped token is also the in-tree precedent for signed-URL minting, which
matters below.

#### Namespace and ownership

Directly transferable from email: pick the unit that needs global uniqueness (a *library* or
*bucket* name), make it the DO name so uniqueness is free, and claim it permanently.

- `MediaLibrary` DO via `getByName(libraryName)`; `claim(accountId)` first-wins, idempotent for the
  same owner, throws for a different one
- **Permanent claims** — releasing a media namespace would let a later user serve bytes from URLs an
  earlier user already published
- **Double canonicalization** — validate/normalize, then re-encode and compare, or `Foo` and `foo`
  become two claims on one library
- R2 keys live under the claimed prefix; the DO holds metadata, R2 holds bytes

#### Where simulation fits — better than most

Uploads are a rare case where [§8.3](#83-simulating-actions) simulation is both cheap and honest,
because **the expensive half is idempotent and the approval only gates visibility**:

1. `upload()` writes bytes to a **staging prefix immediately**, then `submitAction`
2. Pending uploads appear in `list()` with a provisional id — GitHub's pattern, now `ProvisionalIds`
   in `gatekeeper-kit`
3. Approval is a **metadata flip**, not a byte copy
4. `revertAction` moves the object back to staging — genuinely reversible, so
   `implementsRevert: true`
5. `delivery: "continue-with-simulation"`; the agent keeps working

Deletes get the same treatment: soft-delete on approval, revert restores. Most Gatekeepers cannot
offer real revert; this one can, which is worth exploiting rather than defaulting to
`implementsRevert: false`. Describe an upload with a `file` field (name, type, size, SHA-256) so the
approver sees exactly which bytes they are publishing.

Split the surface the usual way: `list()` / `read()` / `getUrl()` are observations; `upload()` /
`delete()` / `replace()` are actions.

#### The real design risk: a public URL escapes the observation model

This deserves deciding **before** any code. A public media URL is a **capability that leaves the
system**. Once an agent obtains one and writes it into a document, anyone with the link reads the
bytes — and none of the platform's controls can reach it:

- `excludeObservers` blocks a *read through the session*, not an HTTP GET to a CDN URL
- `containsRestrictedData` stops the workspace's own web fetches and forces manual approval of its
  actions; it cannot recall a URL already emitted
- The audit log records that a URL was *minted*, never that it was *fetched*

This is the same class of gap as email's — where the observation description carries the subject but
never the body — but larger, because a URL is transferable and an email body is not.

Three defensible resolutions; pick explicitly:

1. **Signed, short-lived URLs minted per observation.** Follows the `ARTIFACTS` precedent
   (`createToken("read", 3600)`). Keeps the capability bounded; costs CDN cacheability.
2. **Public by design**, with the constraint written down: this is a *published-media* CDN, never a
   store for anything access-controlled. Simple and honest, and probably right for a marketing-asset
   library.
3. **Two library classes** — public and signed — with visibility a property of the library, mirroring
   Context's public/private split. Most work; most flexible.

Option 2 with option 3 as the upgrade path is the pragmatic start.

#### Observers

If libraries are minted per-deployment for a gadget, email's **low-stakes strategy** (no-op
`addObserver`, trivial verifier) is defensible on the same reasoning: no external ACL exists and the
gadget's collaborators are the intended audience. The moment media becomes *private per user*, that
argument dies and it needs Context's strategy — track which libraries were revealed, verify every
observer against each.

#### Management UI

`providesUi` with Context's file manager as the template. Per
[§8.5](#85-management-uis-providesui), that path bypasses the approval queue entirely — which is
exactly right for a human dragging files into a media library, and exactly why **we would own
authorization and audit in that path completely**.

#### Why this pairs with §11.1

Storage-GB and transform-count are **meterable units**, which most Gatekeepers do not have. A media
Gatekeeper is the natural first consumer of the `recordUsage(vendorId, unit, qty)` convention
sketched above — and the natural first test of whether a failed `recordUsage` should block the call.

#### Open questions before building

- **Transform binding**: Images binding vs. `/cdn-cgi/image/` URL-based. Neither is bound anywhere
  in-tree today; both need new wiring and a zone.
- **Upload path**: through the Worker (simple, subject to request limits) vs. R2 presigned PUT
  (scales, but the bytes never pass a point where we can validate them).
- **Video is not images**: Stream is a separate product with its own IDs, encoding latency and
  billing. Treat as a second resource type with its own `.d.ts`, per the SKILL tip.
- **Size and quota**: R2 has no per-prefix quota. Enforcement is ours, in the Gatekeeper.

---

## 12. Open items

### Decided, not yet done

- **Finish the GitHub Gatekeeper** (deployed 2026-10-06, §1.6). Create a GitHub **OAuth App** (not
  a GitHub App) under the `weareveerstudio` org, homepage `https://os.veer.studio`, authorization
  callback URL `https://os.veer.studio/gatekeeper/github/oauth`. Install its credentials
  interactively — each `secret put` deploys a new `veeros-gk-github` version, so record both IDs:
  `CLOUDFLARE_ACCOUNT_ID=cae2b6350c3a5a8bc9451652ffb0c9d7 pnpm exec wrangler secret put CLIENT_ID --name veeros-gk-github`,
  then the same for `CLIENT_SECRET`. Then verify a connect end-to-end from an authenticated session
  (connect, read a repository and see the read observed, disconnect). The connect scope includes
  `repo`.
- **Authenticated verification of the `b304e8c2` deploy.** The CLI-checkable items passed (§13.1,
  and again after §1.6); the browser ones have not run for this deploy or the three before it — `/admin` positive and
  negative, a denied identity, the model picker and the new `/admin` Models tab, schedules still
  listed and a new one firing, the Context catalog in a new chat, and an end-to-end connect through
  the handoff flow. Do these before relying on any connector.
- **Turn user search on explicitly.** Decided 2026-09-29: user search **on**. Set the toggle in
  `/admin` rather than relying on the `!signupsEnabled` default (§6), so the choice is stored and
  survives a later signups change.
- **Three blueprints** — message board, todo list, kanban; Basecamp-5 styled, built in-platform from
  `format.document`, promoted via `/admin` → Formats (path A). Read
  `bundled-blueprints/blueprints/workspace-docs/files/server.ts` and `libraries/sync` first to
  decide whether to inherit its `document:v2` revision model. Since `b304e8c2` a published
  blueprint is a git release, and gadgets made from it are offered each later release (§13.1) — so
  republishing ours updates every board already in use, with an agent merging local edits.
- **Context collection** — a git-backed house knowledge base, `public` visibility so it is
  admin-write / everyone-read, with `skills/<name>/SKILL.md` folders.

### Deferred

- `BUNDLED_BLUEPRINTS_DIR` wiring into `buildCommands()` (path B), if bundling is wanted later
- Custom Gatekeeper and Error Reporter — code retained, disabled
- `veeros-gk-billing` scaffold — auto-provisioned Gatekeeper with `providesUi` and a stub portal
- `veeros-gk-media` — R2 + Images/Stream, built on the `gatekeeper-email` "is the service" pattern
  (§11.2). Decide the public-URL question before writing code.
- `gatekeeper-email` — wired but disabled (`email.enabled: false`, §1.6), pending the Email Routing
  decision: which addresses on which zone, and living with `getEmailHost`'s wrong displayed host
  (§9.5). Enabling it is the flag, `workers.email` uncommented, and Email Routing DNS and rules.
- `gatekeeper-basecamp5` — on `gatekeeper-kit` (§9.4)
- Connecting `gatekeeper-cloudflare` for Workers Observability
- Removing the unused `CF_AI_GATEWAY_API_TOKEN` secret from `veeros-backend` (a `secret delete`
  deploys a new version — needs its own approval)

### Watch

- **This repo is not the only thing that deploys to this account.** A full `pnpm deploy` landed on
  2026-09-10 that no commit or note here records (§13.3). Before any deploy, read the live version
  IDs from the account rather than trusting this doc.
- **`pnpm check` does not compile disabled packages** — run `pnpm lint` on every bump (§1.3, §13.2).
- **Upgrades reshape our workspace, not just versions** — keep catalog entries byte-identical, and
  expect new members and new `catalog:` specifiers from the three submodule packages we host
  (§8.6, §13.2, §13.4).
- **`README.md` says "The deployment is six Workers"** — stale; the count is configurable (six
  active here, but not the six it lists: MCP and GitHub instead of the custom Gatekeeper and Reporter)
- **`deploy.ts` reads a generated file.** Since `b304e8c2` each Worker's config is authored in
  `cloudflare.config.ts`; the `wrangler.jsonc` our wrapper reads is generated from it and committed
  (§13.1). If upstream stops committing it, `deploy.ts` breaks — check for it on every bump.
- **Usage metrics are off here.** `METRICS` (Analytics Engine) is optional and the wrapper binds
  nothing, so `recordAnalytics` writes nowhere. Enabling it is a wrapper change (§13.1).
- **Toolchain drift** — our top-level Wrangler resolved to 4.143.0 while the submodule pins 4.138.0.
  Dry-runs and deploys run the submodule's; ours is used only for `whoami`/`secret`/`deployments`.
- **Any future OAuth Gatekeeper** needs `BASE_URL` (automatic for a row in the vendor-Gatekeeper
  table, §1.6; nothing enforces it otherwise), relies on the backend's
  `PUBLIC_BASE_URL`, and must implement the connect handoff (`complete()` → `ConnectHandoff`,
  `reconnectComplete()`, `commitReconnect()`).
- **Typed-storage property names are storage keys** — renaming a persisted field is a migration
  unless it declares `storageKey` / `storageName` (§13.3)
- **Restricted data has a stated `use`-collaborator hole** (§13.3) — relevant before connecting any
  gatekeeper holding client-confidential data to a workspace with `use` collaborators
- **User search exposes emails** to every authenticated user when on, and the directory fills only
  as people sign in (§6)
- **Model configs are credentials** — `extraHeaders` and API keys both live in binding props (§10)
- **`blueprintId` is an install key** — never rename after deploy
- **Upstream `enableHook` / `disableHook` race** (`overseer.ts:11221`) — a losing `enable()` can
  resurrect gatekeeper-side state that keeps consuming alarms and quota. Relevant only once we run a
  hook-driven Gatekeeper of our own.
- **`providesUi` routing keys on vendor id, not account id** (`server.ts:621`) — one UI-declaring
  account per vendor per user, or the extras become unreachable
- **The next storage migration will not be free.** §13.4's rollback-is-gone tradeoff was acceptable
  only because no gadget history existed. Once real gadgets do, a migrating bump needs a parallel
  Workshop identity with its own storage, exercised against a copy, before it touches production.
  (`ef65348f`'s `v3` and `b304e8c2`'s Overseer v5 are additive only.)
- **`gitObjects` has no GC** (§14.1). Gatekeeper-supplied objects are capped at 1 MiB; locally
  written ones only softly. Worth a look at actual object counts once gadgets accumulate history.

---

## 13. Upgrade log

Newest first.

### 13.1 `ef65348f` → `b304e8c2` (2026-10-06) — deployed

49 commits, 2026-09-29 → 2026-10-05. A clean fast-forward; the starter wrapper remains 0 behind
`cloudflare/cloudflare-os-starter`. Bumped on branch `bump/cloudflare-os-b304e8c2` (commit
`dd06ecd`), fast-forwarded into `main`. `pnpm lint`, `pnpm check` (30/30 wrapper tests, all five
active Workers dry-run clean, generated configs removed) and `pnpm test` pass. Upstream's own suites
were not run. `pnpm peers check` reports unmet peers inside vite-plus 1.0's bundled vitest and
Wrangler; not investigated, and nothing failed.

**Deploy record.** Deployed 2026-10-06 12:17–12:23 UTC, account `cae2b6350c3a5a8bc9451652ffb0c9d7`,
route `os.veer.studio`, from root commit `dd06ecd` / submodule `b304e8c2`, after re-reading the live
versions (unchanged since 2026-09-29). All five active Workers deployed in the script's order, exit 0.

| Worker | Previous version (rollback target) | New version |
|---|---|---|
| `veeros-gk-context` | `25fbbd55-bcf1-412d-a666-644800eb52ee` | `8a597940-4016-4872-9d0e-09242537a86e` |
| `veeros-gk-scheduler` | `90e3a47d-1563-4538-a0c2-145f02c61e4b` | `7efc47af-e27a-44c4-8604-cd810d9bac02` |
| `veeros-gk-mcp` | `d717fc33-6b94-4cfb-a2d5-815d62b69f57` | `d25238aa-8803-4106-82b8-a3ea6beaaf10` |
| `veeros-backend` | `022aebcc-4a8c-45db-a5e9-b7d26f07edd5` | `10cea740-8393-43ba-bdb3-4ee02049f07c` |
| `veeros` (router) | `94c4fd56-e271-4338-b19d-e2cd5bae16ac` | `396ae1c7-0d45-4c89-b084-4f793b6d0409` |

**Verified after deploy:** valid TLS on `os.veer.studio`; unauthenticated requests to `/`, `/api/`,
`/admin`, `/gatekeeper/mcp`, `/gatekeeper/context`, `/gatekeeper/scheduler` and `/connect/handoff`
all 302 to `veerstudio.cloudflareaccess.com` carrying the configured audience; every backend
reported *"No targets deployed"* — the Router holds the only route; the new backend version carries
compatibility date `2026-09-04`, the same flags, and the same storage, gatekeeper, AI and Access
bindings as before. **Not verified:** everything needing an authenticated browser session (§12).
Superseded the same afternoon by the GitHub Gatekeeper deploy on this pin (§1.6), whose rollback
targets are these versions.

#### What the wrapper had to change

1. **Catalog re-sync.** `workers-types` `^5.20260924.1`, `vite-plus` `^1.0.0`, `zod` `^4.6.5`; the
   `vite` override is now selected as `vite@*`, because vite-plus 1.0 depends on `vite` as an alias
   for its own core and a bare `vite` override would substitute vite 7 under `vp` (#632). `capnweb`
   stays a single copy (0.12.0). Our root takes `vite-plus` from the catalog, so this moved our own
   `vp` to 1.0 too.
2. **Task `input`/`output` moved under `cache`** in `custom-gatekeeper` and `error-reporter`'s
   `vite.config.ts` — the vite-plus 1.0 task schema (vite-task#749), ported as upstream did. Whether
   the old shape would have failed was not tested.

#### What did not change

`scripts/deploy.ts`, the two submodule scripts it imports, and the five base configs it reads: each
`wrangler.jsonc` parses identical to `ef65348f` (keys sorted, `$schema` dropped). That holds despite
#597, which moved authoring to a `cloudflare.config.ts` per Worker built from
`scripts/worker-config.ts`: the `wrangler.jsonc` beside it is now generated by
`scripts/generate-worker-configs.ts` but still committed, and `pnpm configs:check` fails upstream
on a stale one. No new vars, secrets, bindings or Wrangler migrations. The Gatekeeper contract
changed only in `GitCache.consumePack`'s documentation (#656), so `custom-gatekeeper` still compiles.
`@gadgets/backend-utils` was renamed `@gadgets/observability` (#568); nothing in the wrapper named
it.

#### The Overseer storage migration, and what it does to rollback

**Overseer storage v4 → v5, `migrateToBlueprintUpstreams`** (#659; migrations now live in
`workshop-backend/src/storage-schema/overseer-migrations.ts`, #639). Additive: it backfills an
optional `upstream` on gadget records — the blueprint an agent's `createGadget` call named, or `{}`
for a from-scratch gadget — from at most 1,000 chat messages per workspace. Synchronous, in one
`transactionSync`, chained after `migrateToWorkpieceTypes` in the constructor; it skips the scan
entirely when no gadget lacks an `upstream`.

**Rollback is weaker than the migration suggests.** #659 also changed what a blueprint *is*: a git
release pack in `BLUEPRINT_CONTENT` under `<blueprintId>/<commitId>`, not a gzipped Yjs snapshot
under `<blueprintId>/<version>`, and the `.gadget` archive gained version 2 for it. New code still
reads snapshots, as their snapshot release. Old code reads neither releases nor archive v2 — so
**once a blueprint is published or updated on `b304e8c2`, rolling back to `ef65348f` breaks it**.
Merges are now recorded as git commits rather than OTs as well. Until we publish a blueprint, the
`ef65348f` versions above remain plausible targets; as in §13.2, rollback across a Durable Object
migration is unproven.

#### Behaviour changes that matter to us

- **MCP Gatekeeper security fix** (#668) — it parsed its connect form with `formData()` before
  checking the nonce, so anyone holding a connect URL could make the Worker buffer a body of any
  size into a 128 MB isolate; now capped at 16 KiB. Credential-expiry notifications in five
  gatekeepers also latch only after delivery, so one failed callback no longer silences the
  reconnect prompt for good. We run MCP — the main reason for this deploy.
- **Blueprints are git releases with updates** (#659) — publishing a new release offers it to every
  gadget made from the blueprint (a dot on the blueprints button, not automatic); local edits are
  merged by a spawned agent; a gadget can switch to another blueprint while updating. Shapes the
  three-blueprints plan (§12).
- **`/admin` Models tab** (#616, #657) — enable and test providers, add models (with image input and
  reasoning levels), set default reasoning, without patching `SUGGESTED_MODELS`. Stored in the
  `AdminSettings` DO; `CF_AI_GATEWAY_PROVIDERS` is now a floor that admin-added providers extend.
  Suggested models now include Claude Sonnet 5.5 and GPT-6.1 Sol (#610); superseded models are
  hidden from pickers but still resolve (#611).
- **Agent turns** — resume after auto-approval (#599); a workspace whose loop counter is exhausted
  restarts (#640); the system prompt is sent as a static and a dynamic block for prompt caching
  (#609); agent turns are traced for the Agents dashboard (#595).
- **Usage metrics via Analytics Engine** (#568) — an `activity/v1` writer to a `gadgets_metrics_v1`
  dataset, a no-op without an optional `METRICS` binding the wrapper does not add (§12).
- **Git** — packs stream through `consumePack` instead of being buffered (#656).
- **Not deployed here**: Google Chat for the Google gatekeeper (#560, #606, #649), Gmail fully
  simulating its actions (#638), GitHub refreshing expiring tokens instead of breaking after eight
  hours (#661).
- **Also**: workspace-deletion WebSocket fix (#598), dialog viewport fix (#619), read-only code view
  explained (#633), dependency bumps, and three more rounds of public-API kernel integration tests.

### 13.2 `08afe059` → `ef65348f` (2026-09-29) — deployed

55 commits, 2026-09-14 → 2026-09-28. A clean fast-forward; the starter wrapper remains 0 behind
`cloudflare/cloudflare-os-starter`. Bumped on branch `bump/cloudflare-os-ef65348f` (commit
`e57084c`), fast-forwarded into `main`. `pnpm lint`, `pnpm check` (30/30 wrapper tests, all five
active Workers dry-run clean, generated configs removed) and `pnpm test` pass. Upstream's own suites
were not run.

**Deploy record.** Deployed 2026-09-29 15:08–15:12 UTC, account `cae2b6350c3a5a8bc9451652ffb0c9d7`,
route `os.veer.studio`, from root commit `0558097` / submodule `ef65348f`, after re-reading the live
versions (unchanged since 2026-09-13). All five active Workers deployed in the script's order, exit 0.

| Worker | Previous version (rollback target) | New version |
|---|---|---|
| `veeros-gk-context` | `31f55ebd-5526-47ed-977d-05b18e6fa4fa` | `25fbbd55-bcf1-412d-a666-644800eb52ee` |
| `veeros-gk-scheduler` | `c348f02c-43d8-4a11-bd96-6dd6f4dda510` | `90e3a47d-1563-4538-a0c2-145f02c61e4b` |
| `veeros-gk-mcp` | `1ff0187f-dcf5-42bd-9c40-2d82143840d4` | `d717fc33-6b94-4cfb-a2d5-815d62b69f57` |
| `veeros-backend` | `07d644e5-e59c-4621-a8f9-14005b0282c7` | `022aebcc-4a8c-45db-a5e9-b7d26f07edd5` |
| `veeros` (router) | `593eba4d-a7bd-4239-9ff8-d0e663fb9a4f` | `94c4fd56-e271-4338-b19d-e2cd5bae16ac` |

**Verified after deploy:** valid TLS on `os.veer.studio`; unauthenticated requests to `/`, `/api/`,
`/gatekeeper/mcp`, `/gatekeeper/context`, `/connect/handoff` and `/admin` all 302 to
`veerstudio.cloudflareaccess.com` carrying the configured audience; every backend reported *"No
targets deployed"* — the Router holds the only route; the new backend version carries compatibility
date `2026-09-04`, `PUBLIC_BASE_URL`, and the same storage, gatekeeper, AI and Access bindings as
before. **Not verified:** everything needing an authenticated browser session (§12).

**One local cleanup before building:** the main checkout held a stale, now-unignored
`workshop-backend/src/generated/format-blueprints.ts` from the old pin's build (#466 renamed the
generated module). Nothing referenced it; it was deleted.

#### What the wrapper had to change

1. **Catalog re-sync.** `@gadgets/scripts` — a member of our workspace since §13.4 — now declares
   `typescript6: catalog:` and `zod: catalog:`, so both must resolve here or `pnpm install` fails.
   Added `typescript6` (`npm:typescript@6.0.3`), `zod` (`^4.5.4`) and `miniflare`
   (`5.20260921.1-alpha`); bumped `vitest` to `^4.1.11` and `wrangler` to `^4.138.0`; pointed the
   `@cloudflare/vitest-pool-workers>miniflare` override at the catalog. `capnweb` stays a single
   copy (0.12.0).
2. **`custom-gatekeeper` gained `commitReconnect()`.** A throwing stub, like upstream's Scheduler.
   **This was already broken at `08afe059`**: #464/#473 made `GatekeeperUser.commitReconnect`
   required, so `pnpm lint` failed on `main` from the moment of that bump. §13.3's claim that our
   package was "unaffected" was wrong — it checked for a connect callback, not for the new required
   method. `pnpm check` never noticed because it skips the disabled package (§1.3).

#### What did not change

`scripts/deploy.ts`, the two submodule scripts it imports (`pnpm-command.ts`, `bin-entry.ts`), build
task names, compatibility dates and flags, engines, and every binding — the backend's dry-run
bindings are identical to what is live. The only Wrangler config change is Workshop migration `v3`,
`new_sqlite_classes: ["UserDirectoryDurableObject"]`, reached through `ctx.exports` with no binding;
`deploy.ts` carries `migrations` through from the base config untouched.

**No data migration.** The Overseer's schema and git storage are unchanged in shape. Rollback to
`08afe059` is not proven: whether Cloudflare permits a Worker version rollback across an applied
Durable Object migration must be checked against the rollback docs before relying on it.

#### Behaviour changes that matter to us

- **User directory and search** (#474) — §6. The `!signupsEnabled` default turns search on for
  closed-signup deployments. Decided: on, to be set explicitly in `/admin` (§12).
- **Restricted mode replaces lockdown** (#487), plus **`ownerInvitesOnly`** (#523) and
  **`descriptionIsComplete` / `fields`** (#541, #565) — §8.2, §8.3. A restricted workspace now
  works, with every action manually approved and git pushes refused.
- **Catalog is not an observation and is reloaded every turn** (#267) — §3.5, §8.2. Good for the
  planned skills collection: new skills appear mid-chat.
- **Breaking for gadget code: `spawnCallable(title, options)`** (#492), and **`GIT` is a reserved
  binding name** (#570) — §14.5, §14.7. We have no gadgets yet.
- **Worktrees** gained a code-editor UI, pin-on-first-modification, and a full-40-hex id
  requirement; gadgets gained `env.GIT` (#513, #570) — §14.4, §14.5.
- **Agent tools**: a `grep` tool, `readFile` line windows, a 32K cap on every tool result the model
  sees (#494); `describeBinding` on a gadget's bindings (#573).
- **Models**: pi 0.87.1 adds Claude Opus 5.5, Fable 5.1 and GPT-6 (#556). Manually configured models
  can carry extra headers and context/output limits, and configs can be edited or cloned (#572) —
  see §10 on where those headers live.
- **`gatekeeper-kit`** gained an OAuth 2.0 client; Cloudflare stops expiring accounts on transient
  refresh failures (#555) — §9.3, §9.4.
- **Bundled blueprints moved to TypeScript** in `packages/bundled-blueprints`;
  `FORMAT_BLUEPRINTS_DIR` → `BUNDLED_BLUEPRINTS_DIR` (#466) — §4.2, §4.4.
- **Fixes**: getting stuck on a failed MCP approval (#566) or while verifying access to a shared
  workspace (#559); local workerd moved past a facet use-after-free (local only, #567).
- **Also**: Google Drive folder resource and Docs tables (#440, #518), multi-invite (#526), the
  agent-facing `types.d.ts` self-containment lint (#581, #582), and three rounds of public-API kernel
  integration tests.

### 13.3 `54d5d8b0` → `08afe059` (2026-09-13) — deployed

Six commits, 2026-09-09 → 2026-09-11. `pnpm check` needed no wrapper changes — but `pnpm lint`
would have failed (§13.2).

**Deploy record.** Deployed 2026-09-13 19:31–19:32 UTC, account `cae2b6350c3a5a8bc9451652ffb0c9d7`,
route `os.veer.studio`, from root commit `303dc0a` / submodule `08afe059`. All five active Workers
deployed in the script's order, exit 0. These versions are still live (§2).

| Worker | Previous version | Deployed version |
|---|---|---|
| `veeros-gk-context` | `f8c5cba6-347b-47ae-974b-fd3bb52324b3` | `31f55ebd-5526-47ed-977d-05b18e6fa4fa` |
| `veeros-gk-scheduler` | `8b4315a0-3457-4221-b4d0-a234b6bbb980` | `c348f02c-43d8-4a11-bd96-6dd6f4dda510` |
| `veeros-gk-mcp` | `926160ca-d874-42a5-a109-958fb61d497b` | `1ff0187f-dcf5-42bd-9c40-2d82143840d4` |
| `veeros-backend` | `5b113d30-fdc9-40fb-8c2d-4e16c679a6c7` | `07d644e5-e59c-4621-a8f9-14005b0282c7` |
| `veeros` (router) | `59355b84-6873-457d-b2fa-683ce8ab92cf` | `593eba4d-a7bd-4239-9ff8-d0e663fb9a4f` |

**Verified:** valid TLS on `os.veer.studio`; an unauthenticated request 302s to
`veerstudio.cloudflareaccess.com` with the configured audience; `/api`, `/gatekeeper/mcp` and
`/connect/handoff` sit behind the same Access application; the backend carries compatibility date
`2026-09-04` with `PUBLIC_BASE_URL`; the Router holds the only route. **Not verified:** everything
needing an authenticated browser session (§12).

**`54d5d8b0` had already been deployed** on 2026-09-10 ~10:25 UTC, outside this repo's recorded
history — so the one-way git-storage migration (§13.4) ran then. Hence the §12 rule: read the
account, not this doc.

**Connect flows are bound to the initiating browser** (#464, #473). A connect URL used to be a bearer
capability — an attacker could start a connect and phish a victim into finishing it, delivering the
victim's tokens into the attacker's account. Now the final page posts a single-use ticket (SHA-256 of
a fresh 256-bit value, two-minute lifetime) plus a per-flow nonce, redeemed from the popup over the
initiating user's own session. Consequences:

- **`GatekeeperConnectCallback.complete()` returns a `ConnectHandoff`**, a new
  `reconnectComplete(stageId, expiresAt?)` stages reconnect credentials, and
  **`GatekeeperUser.commitReconnect(stageId)` is required** — the Workshop calls it to make staged
  credentials live. `gatekeeper-kit` ships `connectHandoffPageHtml()` for the final page.
- **`PUBLIC_BASE_URL` is required on the backend for any connect** to complete
  (`workshop-backend/src/connect-handoff.ts`). Ours is set.

**Restricted-data sharing moved from lockdown to per-collaborator verification** (#381, #382, #308).
`prohibitAllSharing` became `containsRestrictedData`, a hard rename. Instead of one restricted
observation blocking sharing with anyone, each collaborator is admitted only while verified as an
observer of the producing gatekeeper, checked at every `open()`. `ef65348f` then replaced the
remaining "no actions" guard with restricted mode (§8.2). Two limits upstream states plainly:

- **Coverage is held to each collaborator's role scope.** An agent can read an *unbound* gatekeeper
  through a chat binding, persist the restricted result into gadget storage or UI state, and expose it
  to an unverified `use` collaborator — a *"Known security limitation"*, accepted.
- **Enforcement is at admission, not at each read**; an unverified redeemer persists in
  `listCollaborators` until removed.

**Typed-storage property names are keys.** The rename was storage-safe only because `typed-storage`
gained `singleton(default, {storageKey})` and `collection(..., {storageName})`, and the overseer keeps
`storageKey: "prohibitAllSharing"` — without it, *"every workspace that has already observed
restricted data would silently unlatch."*

### 13.4 `6478a144` → `54d5d8b0` (2026-09-09) — deployed 2026-09-10

82 commits, 2026-08-18 → 2026-09-08. A clean fast-forward.

#### What the wrapper had to change

Three edits, all forced by upstream repackaging:

1. **`pnpm-workspace.yaml` catalog mirror**, plus a new `@cloudflare/workers-types` entry
   (`workshop-shared` declared it `catalog:`) and the two `@cloudflare/vitest-pool-workers`
   overrides.
2. **`cloudflare-os/scripts` added as a workspace member.** Upstream #431 turned the build tooling
   into `@gadgets/scripts`, and `error-reporting` declares it `workspace:*` — which only resolves
   against the workspace owning the member, ours. Without it: `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.
3. **`package.json` test filter** — `--filter '!@gadgets/scripts'`, because that package's `test`
   task is upstream's workspace-wide CI guard and shells out to a bin not linked into its own `.bin`.

All three follow from the submodule reshaping its own workspace; expect the same classes on future
bumps (§13.2 was class 1 again).

#### The one-way migration

**The only irreversible change so far.** Upstream #275 moved mainline gadget code out of the
workspace-wide Yjs update log into real git commits (§14). `workshop-backend/src/git-migration.ts`
converts a workspace once: it replays the legacy `code`/`snapshots` log, synthesizes a chain of real
commits per gadget, and rewrites every record that referenced a code-log version to a commit —
gadget heads, historical `merge` messages, blueprint records.

- **It runs itself** — in the Overseer DO constructor under `blockConcurrencyWhile`, gated by the
  `version` singleton (`overseer.ts:2002`; `#migrateToGitStorage` at `:2069`, followed by the action-
  index and workpiece-type migrations), on the first request after the Workshop deploy. No dry-run,
  no opt-out.
- **It is safe to crash** — content-addressed writes, deterministic record rewrites, the version stamp
  written last; a chat that already has a `codeBase` is skipped.
- **It is not reversible.** Pre-conversion chat messages keep their retired Yjs bytes "as rollback
  insurance, but nothing can apply them". The old `code`/`snapshots` collections are still present,
  read-only, at `ef65348f` (`overseer.ts:1171`–`1188`); upstream intends to delete them later.

We accepted this deliberately: nothing of consequence had been built in the Workshop. **That
judgement expires the moment real gadgets exist** (§12).

Context storage moved to bytes (#274), backward-compatible on read — pre-existing string rows still
decode.

#### Also in range

Every Worker's compatibility date moved to `2026-09-04` (`workshop-backend` dropped
`enhanced_error_serialization`) — nothing here pins one. New packages `gatekeeper-kit` (a library, not
a Worker) and `workshop-evals`; no deployable identity changed. Themes: gatekeeper-kit foundations,
git storage and worktrees (§14), Google Drive/Docs/Gmail work, observer-verification fixes, new
models, frontend composer and mobile work, and built-in blueprints unpacked into source.

---

## 14. Git-backed code storage and worktrees

New at pin `54d5d8b0` (upstream #275 for the store, #384 for the remote flows), extended at
`ef65348f` (#513 worktree UI, #570 `env.GIT`). Upstream's plans are checked in and worth reading:
`cloudflare-os/plans/git-storage.md`, `plans/worktrees.md`, `plans/worktrees-ui.md`,
`plans/spawner-with-persistence.md`. Paths below are in `workshop-backend/src/` unless stated.

### 14.1 One store per workspace, not one repo per gadget

The natural guess — each gadget gets its own repo — is wrong, and the design says so explicitly.
There is **one git object store per workspace**, held in that workspace's Overseer DO, with every
gadget's history mixed together in it. From `git-store.ts:3`:

> Each workspace's Overseer DO holds a real git object database — SHA-1, zlib-deflated loose
> objects, byte-identical to what `git` itself would write — stored in the `gitObjects`
> typed-storage collection.

Gadgets are separated by *history*, not by *storage*: each gadget record points at its own head
commit (`GadgetRecord.commitId`, `overseer.ts:347`) and its own parent chain, and unrelated DAGs
coexist without interfering because the store is content-addressed. Sharing the store is the point,
not an accident — gadgets forked from each other, or instantiated from the same blueprint,
deduplicate at the blob and tree level for free.

The format is genuinely git, not git-shaped. isomorphic-git supplies the object codec, and only its
plumbing is used — `writeBlob`/`writeTree`/`writeCommit`/`read*`/`log`, against a gitdir containing
nothing but `objects/**`. The porcelain is off-limits by decision: `git.commit` hard-requires
HEAD/index/config, and `git.merge` cannot express the merge behaviour the workspace wants. Upstream
chose real formats so code could later be exported to and imported from real repositories, and so
agents could mount arbitrary repos through gatekeeper-gated push/pull — which is §14.4.

Storage properties worth knowing before we build anything large on it:

- **Loose objects only**, one storage record per object, keyed by oid. isomorphic-git never writes
  deltified data. Dedup comes from content addressing, not deltas.
- **Size limits.** Objects supplied by a gatekeeper (`put()`, `consumePack()`) are capped at
  **1 MiB** and rejected with `GitObjectTooLargeError` (`MAX_GIT_OBJECT_SIZE`, `git-cache.ts:81`);
  packs at 64 MiB. Locally written objects are bounded indirectly — a source file is at most 512K
  UTF-16 units (`MAX_FILE_TEXT_LENGTH`, `workshop-shared/src/code-change.ts:127`) — and the store's
  own comment still describes a soft ~2 MB ceiling. Spilling large blobs to R2 is noted as later work.
- **No GC.** Dangling objects come only from accepted merges, imports and migration — never from
  in-flight chats — and are considered cheap. The roots, including blob stamps from agent reads, are
  enumerable if GC is ever needed.
- **Commit identity** (`git-store.ts:666`–`678`): the author's name is their display name; the email
  is their **preferred git email** if set (Settings → `setOwnCommitEmail`), else their id if it
  contains `@`, else `<id>@localhost`. The preferred email is self-asserted — attribution only, never
  identity.

### 14.2 What is *not* involved: Artifacts, R2, refs

**Cloudflare Artifacts is not what backs this**, though the guess is a fair one — Artifacts is a
real Cloudflare product ("Git-compatible file storage on Cloudflare Workers"), and this deployment
already uses it. Upstream never writes down a rejection, so what follows is the constraint set,
not a quoted decision.

*What Artifacts actually is here.* A Workers binding whose entire surface is a **control plane**:
`create`, `get`, `import`, `list`, `delete`, and on a repo handle `createToken`, `listTokens`,
`revokeToken`, `fork`. There is no object or file read/write on the binding at all. Content is
reached the ordinary way — mint a scoped token, then speak git over HTTPS. That is exactly what
`gatekeeper-context/src/artifact-sync.ts` does for Context collections: `repo.createToken("read",
3600)` (`:225`), clone over `isomorphic-git/http/web` with the token as HTTP basic auth, revoke the
token afterward. Our `context.artifacts` block in `deployment.jsonc` generates a first-class
`artifacts` wrangler binding (`ARTIFACTS`, namespace `veeros-context-collections`) — not a KV
namespace; `kvNamespaceId` / `CONTEXT_COLLECTIONS` is the separate one.

*The decisive constraint is availability, and it is stated outright* — in
`scripts/release/manifest-lib.ts:251`, of all places:

> gatekeeper-context's Artifacts binding is closed-beta and cannot be provisioned in arbitrary
> user accounts; it is dropped from customer manifests (the gatekeeper degrades gracefully).

The release manifest *cuts* the binding for customer instances, and `ARTIFACTS_CUT_ALLOWED`
(`:256`) hard-fails the build if any package other than `gatekeeper-context` declares one:
*"only gatekeeper-context's is known (and cut). Decide how customer instances should handle this
one."* Context can survive the cut because git-backed collections are an optional feature that
degrades to unavailable. A Workshop whose **entire code storage** were Artifacts could not degrade
at all — it would simply not run in most accounts. That alone rules it out for the kernel,
independent of any design preference.

*The structural mismatch points the same way* (this part is inference from the API surface, not
upstream's words). The store is read on the hot path — every `readFile`, every tree walk, every
`isAncestor` step — and Artifacts offers no way to read one object. Reaching it means a token and
a git fetch, i.e. the Overseer DO leaving the isolate to speak a wire protocol to fetch bytes it
would otherwise read straight out of its own storage. It also mints *repositories*, which is the
per-gadget-repo model §14.1 explicitly rejected, and it carries a ref layer the workspace
deliberately does not want (see below). And a write token is a credential to store, rotate and
revoke — which is why the operator skill treats Artifacts repository write tokens as credentials.

Where Artifacts *would* fit is the direction upstream actually gestures at: the store uses real git
formats specifically so code can later be exported to and imported from real repositories, and
`Artifacts.import()` takes an HTTPS git remote. An "export this gadget to a repo" path is a
plausible future use. Nothing implements it today.

**R2 is not involved either.** The objects live in the Overseer DO's own storage via the
`gitObjects` typed-storage collection (`overseer.ts:1196`) — the same SQLite-backed storage that
holds gadget records and chats. Our `veeros-blueprint-content` R2 bucket is unaffected.

**There is deliberately no ref layer.** No branches, no tags, no HEAD. The store is objects only.
What plays the role of refs is the workspace's own records: gadget records, blueprint records, and
chats' pinned commits — all managed by the Overseer's workflow. A gatekeeper that wants branch and
tag semantics has to provide them in its own API, which is exactly what the GitHub gatekeeper does
(§14.6). Being refless is what lets unrelated histories share one store safely.

### 14.3 The merge model: the chat is the branch

The rule is short and worth internalising, because it governs what the agent can and cannot do to
mainline:

- **Committing to mainline is only ever a fast-forward.** Accept (`mergeChanges`, `overseer.ts:4374`)
  requires that the chat has already merged the gadget's head commit, and then creates a plain commit
  on top of head; otherwise it returns `stale`.
- **If mainline moved, you update the chat, not mainline.** A 3-way merge (diff3) of
  merged-head / head / chat trees is computed and delivered *into the chat*
  (`updateChatFromMainline`, `:4271`), advancing the chat's merged commit. Conflicts are left inline
  as ordinary 3-way conflict markers for the user or their agent to clean up, and then accept is
  retried.
- **Yjs is now only the representation of uncommitted changes within a chat.** CRDT merge across
  divergent bases produces nonsense, so it is explicitly not used for cross-base merging; conflict
  markers are considered better.
- **Editing happens only within chats.** The code editor lets a user edit only with a chat selected
  and no agent turn running.

So: the chat *is* the branch, mainline only ever advances by simple commits, and the whole design
is laid out to allow multi-commit chat sessions later without changing the mainline rule.

### 14.4 Worktrees — mounting a remote commit

A **worktree** is a kind of workpiece: a file tree rooted at a git commit, which the agent reads
and edits with its ordinary file tools, but which has **no runnable code** — you cannot execute a
worktree as a gadget. This is the "mount an arbitrary repo" capability the store was built for.

Structurally it reuses everything: `WorkpieceRecord = GadgetRecord | WorktreeRecord`
(`overseer.ts:454`; `WorktreeRecord` at `:380`), in the same `gadgets` collection, and their edits
ride the existing chat OT stream, so read-before-edit, replay and compaction all work unchanged.

What shapes their use today:

- **Chat-scoped.** A worktree belongs to the chat that created it and is deleted with the chat
  (`:386`). Workspace-scoped worktrees still do not ship. **Spawned agents can now create and edit
  worktrees** (never gadget code).
- **Pinned on first modification, not at birth.** A worktree carries `pinBase` (the accepted commit),
  `headCommit` and, when pinned, `baseCommit`. Until the first write or `commit()` it reads lazily as
  `pinBase`. Accept auto-commits the dirty overlay and advances `pinBase` without re-pinning.
  Creating a worktree proposes nothing, and reverting the creation rolls back content and head but
  never deletes the record.
- **It has a UI** (#513). Worktrees appear in the code editor while their owning chat is selected: a
  *Changes* list against the review base above a *Files* tree, files loaded lazily into the diff
  editor, user edits when the agent is idle, and Accept / Discard / per-turn revert exactly as for
  gadgets — which now share the same browser. The client reads through `Overseer.listTree(commitId)`
  and `readFilesAtCommit(commitId, paths)`; worktree content is no longer stripped from client
  delivery.
- **Objects arrive mostly lazily.** Creation pulls the commit, its full tree structure and blobs up
  to 64 KiB (`depth: 1`, `git-cache.ts:883`–`905`); larger blobs fault in through the owning
  gatekeeper (§14.6).

### 14.5 The git flows exposed to the agent and to gadgets

Three surfaces.

**Tools** (`agent.ts`) — the normal path, and the one the agent is told to prefer:

| Tool | Git-relevant behaviour |
|---|---|
| `createWorktree(title, bindingName, commitId)` | Mounts a commit as a file tree under a binding name. `commitId` must be a **full 40-hex** id — prefixes are refused (`resolveCommitId`, `git-cache.ts:855`), because commit ids are read capabilities — and already *known to this workspace*, typically from a connection's API. `GIT` cannot be a binding name. |
| `readFile` / `writeFile` / `editFile` | Take a `workpiece` parameter, so they address a gadget or a worktree identically. `readFile` accepts `startLine`/`lineCount` and ends a window with `[lines A-B of N; next startLine: B+1]`. An unpinned read stamps the blob it saw; the first `editFile` requires that blob to still be head, then pins. |
| `grep(workpiece, pattern, path?)` | New: a JS regex over a gadget's or worktree's files, `path:line:text` output. |
| `describeBinding(name, gadget?)` | Serves a binding's API to the agent as text — now also a binding inside a named gadget's env, and `env.GIT`. |

Every tool result the model sees is capped at **32K characters**, keeping head and tail
(`MAX_TOOL_RESULT_CHARS`, `agent.ts:76`); `describeBinding` is exempt. An unwindowed `readFile` of a
large file returns whole lines up to the cap with a continuation note.

**The worktree binding** (`worktree-binding.d.ts`) — the programmatic escape hatch from
`executeCode`. All methods are async:

```ts
listFiles(path?, {recursive?})                     // kind: file | executable | dir | symlink | submodule
readFile(path) / writeFile(path, text) / deleteFile(path)   // edited executables keep their bit
grep(pattern: RegExp, path?: string | string[])    // `grep -n` format, for humans/agents to read
structuredGrep(pattern, path?)                     // parse this one instead
commit(message): string                            // commits everything, advances head, returns oid
diff(commitId?) / structuredDiff(commitId?)        // vs. head by default; full ids only
```

- **There is no staging area.** `commit()` takes everything you have changed. No index, no `git add`.
- **There is no branch, checkout, or ref anything** — consistent with §14.2. The worktree has a
  head, and `commit()` moves it.
- **`merge` and *soft* reset are TODO.** A hard reset is better done by creating a new worktree from
  the base commit, which is cheap.
- **`structuredDiff()`** returns `{files, errors}` with per-file status and numbered hunk lines —
  meant for UIs. Renames appear as remove + add.
- **Symlinks and submodules are visible but inert** — listed with their own `kind`; file operations
  on them throw a descriptive error.

**`env.GIT`** (#570; `Git` in `worktree-binding.d.ts:25`, `git-binding.ts:116`) — in every gadget env
and every agent `executeCode` env, unless a named binding shadows it:

```ts
newWorktree(commitId): Promise<Worktree>      // transient, in-memory; commits persist, edits don't
readCommit(commitId): Promise<CommitMetadata> // parents, message, author, committer; no checkout
```

Both require full 40-hex ids. `GIT` is reserved: binding or renaming to it is refused, new spawner
configs reject it, and legacy seeds using it are renamed. For agents, `createWorktree` remains the
preferred path; `env.GIT` is for gadget code that manipulates commits.

So the agent's loop against a real repository is: ask a gatekeeper for a commit id → `createWorktree`
on it → read/edit/grep with the ordinary tools (or `executeCode` for bulk work) → `commit()` → hand
the resulting oid back to the gatekeeper to push or open a PR. Nothing in that loop lets the agent
reach a remote directly; the gatekeeper is the only door, and §14.6 is what it opens onto.

### 14.6 `GitCache` — the gatekeeper side

`GitCache` (`gatekeeper.ts:1570`) is how a gatekeeper populates and reads the workspace's object
store. Any gatekeeper offering access to a remote repo **must** implement `Gatekeeper.gitPull()`
alongside it (`:904`), because the workspace may evict objects and expects to repopulate them from
the same gatekeeper on demand.

```ts
get(id, hints?)        // null outside this gatekeeper's scoped view
has(id) / stat(id)
put(type, content)     // returns the computed oid — also the proof of possession
advertiseCommit(id)    // "my remote has this; pull it from me if the agent mounts it"
buildPack()            // action-scoped only: the applying action's pending-push closure
consumePack(stream)    // decode + hash-verify + store, equivalent to put() per object
isAncestor(a, b)       // over locally cached history only; throws if b isn't cached
```

Three design choices are worth carrying into anything we build:

- **The cache cannot be poisoned.** `put()` computes the oid from the bytes themselves; a gatekeeper
  that gets back an oid it did not expect should throw. Object ids are treated as capabilities
  throughout the system — which is also why `isAncestor` is deliberately *not* scoped to one
  gatekeeper's view, since the caller already holds both oids.
- **Every stub is scoped to the gatekeeper it was handed to**, and answers for exactly two sets:
  objects that gatekeeper `put()` or successfully pushed, and objects *queued* for push by a
  submitted-but-unapplied action (`ActionDescription.pushedCommits`, `:1373`). That second set is
  what makes simulation (§8.3) work for git: a commit pending push reads back as though it had
  already landed.
- **Pulls are shallow and filtered by default.** `GitPullHints` (`:1673`) carries the object type,
  what referenced it, a `commitHistory` of `full` / `depth` / `since` — required, precisely because
  "the intuitive default would be a full clone, but that is almost never what we want" — and
  `filterBlobSize` / `filterTreeDepth`. Hints are advisory.

The GitHub gatekeeper implements this against the **real git smart-HTTP v2 protocol**, not the REST
API: `gatekeeper-github/src/git-transport.ts` composes pkt-line framing, fetch commands and sideband
demultiplexing for pulls, and a send-pack ref-update block for pushes, with the pack bytes coming
from `GitCache.buildPack()` and going into `consumePack()`. Two locked decisions: it never sends
`have`s (every pull is filtered or tree-limited, so possessing a commit never implies possessing its
blobs), and at most one `filter` line per fetch. Transfers are capped at 64MB. The gatekeeper handles
framing only and retains nothing locally.

Its agent-facing repository API is where branches and tags come back (`gatekeeper-github/src/types.d.ts`):
`listBranches`, `listTags`, `resolveRef(ref?)`, `getCommit(ref?)`, `listCommits(options?)`,
`push(branch, commitId, {force?})`, plus PR operations. Every commit id it returns is advertised
through `advertiseCommit()` — except ids that are only *pending push*, which are withheld
deliberately, since the hint would outlive a rejection.

**Push is an approval-gated action, not a call** (`github.ts:5494`). `push()` validates the branch
name, refuses a non-40-character commit id, reads the branch's current head as an authorized
observation to bind the expected old sha, checks fast-forward via `isAncestor`, and submits an action
carrying `pushedCommits: [commitId]` and `implementsRevert: true`. Its description reads *"Push commit
X to branch Y of repo, moving the branch from its current head Z."*, and a force push adds *"This is a
force push: it rewrites the branch's history."* **In a restricted-data workspace every push is
refused outright** (§8.2); a push description is never `descriptionIsComplete`.

### 14.7 Spawned agents

Gadgets can start agents through the agent-spawner binding (`agent-spawner-binding.d.ts`). #492
rebuilt callable agents to survive restarts, and **the API broke**:

- `spawn(title, prompt)` is unchanged. **`spawnCallable(title, {types, mainType})`** replaced
  `spawnCallable(title, prompt)`: the gadget supplies TypeScript declarations (doc comments explain
  each call) and the implemented interface's name; the kernel frames the prompt. The old string form
  throws *"spawnCallable(title, prompt) has been replaced…"*.
- **Calls are durable jobs, not RPCs.** A method call resolves once recorded; there is **no return
  value and no completion notification**. A gadget that wants a result defines a callback in the
  interface.
- **Every stub in the arguments must be persistent** (`ctx.restore()`); transient stubs are refused
  (*"Arguments to a callable agent must be storable…"*).
- The returned stub can be stored in DO storage to call the same agent again. Arguments reach the
  agent as `env.<method>_ARGS`.
- Spawned agents get a restricted tool set — `readFile`, `grep`, `writeFile`, `editFile`,
  `createWorktree`, `webFetch`, `observeUserChanges`, `describeBinding`, `executeCode` — and may edit
  worktrees but never gadget code.

### 14.8 What this means for us

- **The §12 Context-collection plan is unaffected.** A git-backed Context collection still goes
  through Artifacts and `artifact-sync.ts` (§14.2).
- **A `gatekeeper-basecamp5` gets a new obligation if it ever returns commit ids** — implement
  `gitPull()`, or don't hand out oids. For a Basecamp gatekeeper this is moot; for anything wrapping
  a code host it is the main structural requirement.
- **"Agent edits our repo and opens a PR" is a shipped path**, now with a UI to review the worktree
  before accepting — but it needs the GitHub gatekeeper connected and an OAuth app registered, every
  push is an approval prompt, and pushes are impossible from any workspace that has seen restricted
  data. As an *unattended* workflow it is not an option, by design.
- **Blueprints can do git now.** `env.GIT` gives our own gadget code commit inspection and transient
  worktrees — relevant if a kanban or board blueprint ever wants to show repository activity.
- **Keep binaries out of the git store.** Gatekeeper-supplied objects stop at 1 MiB and nothing is
  ever collected; the §11.2 media sketch should keep bytes in R2, nowhere near a worktree.
