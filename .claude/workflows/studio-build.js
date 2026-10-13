export const meta = {
  name: 'studio-build',
  description: 'Build a VEER Studio OS target from its approved spec, review it, and stop before deploy',
  whenToUse: 'After the user has approved docs/studio-os/specs/<target>.md. Args: { target: "foundation" | "clients" | "finance" | "projects" }. Never deploys.',
  phases: [
    { title: 'Plan', detail: 'extract and validate the work breakdown' },
    { title: 'Build', detail: 'one agent per work package, in dependency order' },
    { title: 'Green', detail: 'pnpm lint, test and check until they pass' },
    { title: 'Review', detail: 'four lenses, each adversarially verified' },
    { title: 'Fix', detail: 'apply confirmed findings, then re-green' },
    { title: 'Report', detail: 'deploy plan and manual verification checklist' },
  ],
}

const target = typeof args === 'string' ? args : args && args.target
if (!target) throw new Error('Pass args: { target: "foundation" }')

const ROOT = '/Users/shahriar/Developer/veer.studio/products/os'
const CANON = 'docs/studio-os/architecture.md'
const SPEC = `docs/studio-os/specs/${target}.md`
const REPORT = `docs/studio-os/reports/${target}.md`

const RULES = `Repo root: ${ROOT}. Canon: ${CANON}; spec: ${SPEC} — read both first; the spec is approved, build exactly it. The submodule cloudflare-os/ is read-only — never edit it. Hard rules: never deploy, never run wrangler deploy/secret/delete/rollback/versions commands, never change Cloudflare, Access or Email Routing configuration, never git commit/push/stash/switch branches or discard others' changes. Match the surrounding code's style; load the coding-standards skill if it is available.`

// ---- Plan ----------------------------------------------------------------------------------
phase('Plan')
const plan = await agent(
  `${RULES}\n\nRead section 11 "Work breakdown" of ${SPEC} and return its packages exactly as written (do not edit, merge or invent packages).`,
  {
    label: 'plan',
    schema: {
      type: 'object',
      properties: {
        packages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              paths: { type: 'array', items: { type: 'string' } },
              dependsOn: { type: 'array', items: { type: 'string' } },
              instructions: { type: 'string' },
              acceptance: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'title', 'paths', 'dependsOn', 'instructions', 'acceptance'],
          },
        },
      },
      required: ['packages'],
    },
  },
)
if (!plan || !plan.packages.length) throw new Error(`No work breakdown found in ${SPEC}`)
const packages = plan.packages

// Validate: unique ids, known deps, disjoint ownership, no cycles. Plain code, not an agent.
const errors = []
const byId = {}
for (const p of packages) {
  if (byId[p.id]) errors.push(`duplicate package id ${p.id}`)
  byId[p.id] = p
}
for (const p of packages) for (const d of p.dependsOn) if (!byId[d]) errors.push(`${p.id} depends on unknown ${d}`)
const stem = (path) => path.split('*')[0]
for (let i = 0; i < packages.length; i++)
  for (let j = i + 1; j < packages.length; j++)
    for (const a of packages[i].paths)
      for (const b of packages[j].paths)
        if (stem(a).startsWith(stem(b)) || stem(b).startsWith(stem(a)))
          errors.push(`${packages[i].id} (${a}) and ${packages[j].id} (${b}) own overlapping paths`)
const order = []
const state = {}
const visit = (id, trail) => {
  if (state[id] === 'done') return
  if (state[id] === 'visiting') { errors.push(`dependency cycle: ${trail.concat(id).join(' -> ')}`); return }
  state[id] = 'visiting'
  for (const d of byId[id] ? byId[id].dependsOn : []) visit(d, trail.concat(id))
  state[id] = 'done'
  if (byId[id]) order.push(byId[id])
}
for (const p of packages) visit(p.id, [])
if (errors.length) {
  log(`Work breakdown is invalid; fix ${SPEC} and re-run`)
  return { target, status: 'invalid-spec', errors }
}
log(`${packages.length} packages: ${order.map((p) => p.id).join(' -> ')}`)

// ---- Build: each package starts as soon as its dependencies finish (no global barrier) ----
const BUILD = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'filesChanged', 'checks', 'blockers'],
}
const running = {}
for (const p of order) {
  running[p.id] = Promise.all(p.dependsOn.map((d) => running[d])).then((deps) => {
    const failed = p.dependsOn.filter((d, i) => !deps[i] || deps[i].status !== 'done')
    if (failed.length) {
      log(`${p.id} skipped: dependency ${failed.join(', ')} not done`)
      return { id: p.id, status: 'skipped', summary: `dependencies not done: ${failed.join(', ')}` }
    }
    const depNotes = p.dependsOn.map((d, i) => `- ${d}: ${deps[i].summary}`).join('\n') || '- none'
    return agent(
      `${RULES}

Implement work package "${p.id}" — ${p.title}.
You own ONLY these paths (other agents are editing other paths concurrently; do not touch anything else): ${p.paths.join(', ')}
${p.paths.some((x) => x.includes('pnpm-workspace.yaml')) ? 'You own the dependency files: add every dependency the spec needs and run pnpm install.' : 'Do not add dependencies or run pnpm install; if you need one, report it as a blocker.'}

Instructions:
${p.instructions}

Acceptance (verify each yourself with the narrowest command that proves it):
${p.acceptance.map((a) => `- ${a}`).join('\n')}

Completed dependencies:
${depNotes}

Return status "done" only if every acceptance item passes.`,
      { label: `build:${p.id}`, phase: 'Build', schema: BUILD },
    ).then((r) => (r ? { ...r, id: p.id } : { id: p.id, status: 'blocked', summary: 'agent returned nothing' }))
  })
}
const built = await Promise.all(order.map((p) => running[p.id]))
const notDone = built.filter((b) => b.status !== 'done')
if (notDone.length) log(`Not done: ${notDone.map((b) => `${b.id} (${b.status})`).join(', ')}`)

// ---- Green ---------------------------------------------------------------------------------
const GREEN = {
  type: 'object',
  properties: {
    green: { type: 'boolean' },
    commands: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, ok: { type: 'boolean' } }, required: ['cmd', 'ok'] } },
    remaining: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['green', 'commands', 'remaining', 'summary'],
}
const makeGreen = async (tag, rounds) => {
  let last = null
  for (let i = 1; i <= rounds; i++) {
    last = await agent(
      `${RULES}

From the repo root run, in order: pnpm lint, pnpm test, pnpm check (a validation dry-run; it must not deploy — if anything tries to deploy, stop). Fix every failure caused by this target's changes (see git status / git diff). Never weaken or skip tests, never disable lint rules, never edit cloudflare-os/. Report green=true only if all three pass.${last ? `\nPrevious round left: ${last.remaining.join('; ')}` : ''}`,
      { label: `green:${tag}-${i}`, phase: tag === 'build' ? 'Green' : 'Fix', schema: GREEN },
    )
    if (last && last.green) return last
  }
  return last
}
phase('Green')
let green = await makeGreen('build', 3)
log(green && green.green ? 'lint, test and check pass' : 'still red after 3 rounds; reviewing anyway')

// ---- Review: each lens verifies its own findings as soon as it finishes ---------------------
phase('Review')
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['title', 'file', 'detail', 'fix', 'severity'],
      },
    },
  },
  required: ['findings'],
}
const LENSES = [
  { key: 'access', prompt: 'ACCESS AND DATA: admin-only enforcement in app and agent paths, restricted-data marking, observer strategy, catalog leakage, narrowness of the ui capability, per-account versus shared state, revoke() behaviour, the audit log for human edits.' },
  { key: 'agent', prompt: 'APPROVALS AND AGENT SURFACE: action kinds (autoApprovable, delivery, simulation), no action kind that could stall the queue, descriptions built with the kit builder, human-only operations not exposed to agents, every read authorized as an observation, types.d.ts self-contained and honest.' },
  { key: 'deploy', prompt: 'CONTRACT AND DEPLOY SAFETY: conformance with cloudflare-os/packages/workshop-shared/src/gatekeeper.ts at the pin, scripts/deploy.ts changes, generated configs of existing Workers unchanged when the target is disabled, BASE_URL, compatibility flags, Durable Object migrations, workers_dev and preview URLs off, catalog entries byte-identical, test coverage of the deploy changes.' },
  { key: 'spec', prompt: 'SPEC CONFORMANCE AND UI: every acceptance item in the spec, Kumo and theme conventions, flat ui API, no reliance on popups or downloads, missing or half-built features.' },
]
const reviewed = await pipeline(
  LENSES,
  (lens) =>
    agent(`${RULES}\n\nREAD-ONLY review of this target's changes (git diff against main plus new files). Lens — ${lens.prompt}\nReport only real defects with a concrete fix.`, {
      label: `review:${lens.key}`,
      phase: 'Review',
      schema: FINDINGS,
    }),
  (res, lens) => {
    if (!res || !res.findings.length) return { lens: lens.key, confirmed: [] }
    return agent(
      `${RULES}\n\nREAD-ONLY. Adversarially verify each finding below: try to REFUTE it from the code and the upstream contract. Keep only findings you could not refute.\n\n${JSON.stringify(res.findings, null, 2)}`,
      {
        label: `verify:${lens.key}`,
        phase: 'Review',
        schema: {
          type: 'object',
          properties: {
            confirmed: { type: 'array', items: FINDINGS.properties.findings.items },
            refuted: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
          },
          required: ['confirmed', 'refuted'],
        },
      },
    ).then((v) => ({ lens: lens.key, confirmed: v ? v.confirmed : res.findings }))
  },
)
const confirmed = reviewed.filter(Boolean).flatMap((r) => r.confirmed.map((f) => ({ ...f, lens: r.lens })))
log(`${confirmed.length} confirmed finding(s)`)

// ---- Fix -----------------------------------------------------------------------------------
phase('Fix')
let fixed = null
if (confirmed.length) {
  fixed = await agent(
    `${RULES}\n\nApply these confirmed review findings (you may now edit any file this target owns, never cloudflare-os/). If one turns out wrong on closer reading, skip it and say why.\n\n${JSON.stringify(confirmed, null, 2)}`,
    {
      label: 'fix',
      phase: 'Fix',
      schema: {
        type: 'object',
        properties: {
          applied: { type: 'array', items: { type: 'string' } },
          skipped: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] } },
        },
        required: ['applied', 'skipped'],
      },
    },
  )
  green = await makeGreen('fix', 2)
}

// ---- Report --------------------------------------------------------------------------------
phase('Report')
const report = await agent(
  `${RULES}

Write ${REPORT} for the user (create directories as needed; it is the only file you may write). Sections:
1. What was built — packages and key files.
2. Checks — the last pnpm lint/test/check results.
3. Review — confirmed findings and how each was resolved; anything skipped.
4. Deploy plan — the deployment.jsonc change that enables it, the commands in order, the live version IDs to read first (wrangler deployments list per Worker), what to record afterwards, and rollback.
5. Manual verification — a checklist for a signed-in browser session at https://os.veer.studio.
6. Follow-ups and anything not done.
Facts to include:
Build results: ${JSON.stringify(built)}
Last green run: ${JSON.stringify(green)}
Confirmed findings: ${JSON.stringify(confirmed)}
Fix results: ${JSON.stringify(fixed)}`,
  {
    label: 'report',
    phase: 'Report',
    schema: { type: 'object', properties: { reportPath: { type: 'string' }, summary: { type: 'string' } }, required: ['reportPath', 'summary'] },
  },
)

return {
  target,
  status: notDone.length ? 'incomplete' : green && green.green ? 'ready-for-deploy-review' : 'red',
  packages: built.map((b) => ({ id: b.id, status: b.status })),
  green: green ? green.green : false,
  confirmedFindings: confirmed.length,
  report: report ? report.reportPath : null,
  summary: report ? report.summary : null,
}
