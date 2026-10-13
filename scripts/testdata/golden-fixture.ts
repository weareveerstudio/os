// Inputs for the golden test in `deploy.test.ts`: synthetic base configs and three deployments.
//
// The bases are written out here rather than read from the submodule so the golden output changes
// only when the wrapper's transformation does, not on every upstream bump. They carry every key
// `generateConfigs` reads, replaces, or must leave alone.
//
// `generated-golden.json` beside this file is what `main`'s generator produced from these inputs
// before studio gates existed. With every studio gate off, today's generator must still produce it
// byte for byte. Regenerate it only for an intentional change to existing Workers' output, and say
// so in the commit.

import type { BaseConfigs, DeploymentConfig } from "../deployment-config.ts";

const observability = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { invocation_logs: false },
};

/** One synthetic upstream base config per Worker. */
export const goldenBases: BaseConfigs = {
  router: {
    name: "router",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    observability,
    assets: {
      binding: "ASSETS",
      directory: "../workshop-frontend/dist",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/gatekeeper/*"],
    },
  },
  workshop: {
    name: "workshop-backend",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    compatibility_flags: ["nodejs_compat"],
    observability: { ...observability, traces: { enabled: false, head_sampling_rate: 1 } },
    vars: { ADMINS: [], PUBLIC_BASE_URL: "http://localhost:8787" },
    secrets: { required: ["SOMETHING_UPSTREAM"] },
    assets: { binding: "ASSETS", directory: "./dist" },
    services: [{ binding: "UPSTREAM_ONLY", service: "upstream" }],
    kv_namespaces: [{ binding: "BLUEPRINTS" }],
    r2_buckets: [{ binding: "BLUEPRINT_CONTENT" }],
    migrations: [{ tag: "v1", new_sqlite_classes: ["Overseer", "User"] }],
  },
  context: {
    name: "gatekeeper-context",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    observability,
    kv_namespaces: [{ binding: "CONTEXT_COLLECTIONS" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "upstream-default" }],
    migrations: [{ tag: "v1", new_sqlite_classes: ["ContextLibrary"] }],
  },
  scheduler: {
    name: "gatekeeper-scheduler",
    main: ".wrangler/validate/src/worker.ts",
    compatibility_date: "2026-09-04",
    compatibility_flags: ["allow_irrevocable_stub_storage", "nodejs_als"],
    observability,
    migrations: [{ tag: "v1", new_sqlite_classes: ["ScheduleDriver", "SchedulerGatekeeper"] }],
  },
  mcp: {
    name: "gatekeeper-mcp",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    observability,
    vars: { MCP_ALLOW_INSECURE: "false", BASE_URL: "http://localhost:8787/gatekeeper/mcp" },
    migrations: [{ tag: "v0", new_sqlite_classes: ["McpAccount"] }],
  },
  github: {
    name: "gatekeeper-github",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    observability,
    migrations: [
      { tag: "v0", new_sqlite_classes: ["UserAccount", "GitHubGatekeeperImpl"] },
      { tag: "v1", new_sqlite_classes: ["GitHubHookDriver"] },
    ],
  },
  email: {
    name: "gatekeeper-email",
    main: "src/index.ts",
    compatibility_date: "2026-09-04",
    observability,
    routes: [{ pattern: "upstream.example.com", custom_domain: true }],
    migrations: [{ tag: "v0", new_sqlite_classes: ["UserAccount"] }],
  },
  customGatekeeper: {
    name: "custom-gatekeeper",
    main: ".wrangler/validate/src/index.ts",
    compatibility_date: "2026-08-04",
    compatibility_flags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
    vars: { CUSTOM_NAME: "Example", CUSTOM_MESSAGE: "Replace this." },
    migrations: [{ tag: "v0", new_sqlite_classes: ["CustomGatekeeper"] }],
  },
  errorReporter: {
    name: "error-reporter",
    main: "src/index.ts",
    compatibility_date: "2026-08-04",
    observability,
  },
  probe: {
    name: "gate-probe",
    main: ".wrangler/validate/src/worker.ts",
    compatibility_date: "2026-09-04",
    compatibility_flags: ["allow_irrevocable_stub_storage", "nodejs_als"],
    observability,
    migrations: [{ tag: "v1", new_sqlite_classes: ["StudioAccountState"] }],
  },
};

const common = (): Pick<DeploymentConfig, "accountId" | "access" | "observability"> => ({
  accountId: "0123456789abcdef0123456789abcdef",
  access: {
    issuer: "https://acme.cloudflareaccess.com",
    audience: "access-audience",
    admins: ["admin@example.com", "partner@example.com"],
  },
  observability: {
    enabled: true,
    headSamplingRate: 0.5,
    logs: { invocationLogs: false },
    traces: { enabled: true, headSamplingRate: 0.25 },
  },
});

const workers = {
  router: { name: "acme-os", route: { customDomain: "os.example.com" } },
  workshop: { name: "acme-os-backend" },
  context: { name: "acme-os-context" },
  scheduler: { name: "acme-os-scheduler" },
  mcp: { name: "acme-os-mcp" },
  github: { name: "acme-os-github" },
  email: { name: "acme-os-email" },
  customGatekeeper: { name: "acme-os-custom" },
  errorReporter: { name: "acme-os-errors" },
  probe: { name: "acme-os-probe" },
};

/**
 * Three deployments covering every branch `generateConfigs` takes for the Workers that existed
 * before studio gates. Each carries a disabled probe, which `main`'s generator ignored.
 */
export const goldenDeployments: Record<string, DeploymentConfig> = {
  everythingOn: {
    ...common(),
    publicBaseUrl: null,
    workers: structuredClone(workers),
    aiGateway: {
      enabled: true,
      name: "acme-ai",
      accountId: "fedcba9876543210fedcba9876543210",
      providers: ["anthropic", "google", "cloudflare"],
    },
    context: {
      sharingDomain: "https://legacy.example.com",
      kvNamespaceId: "context-kv-id",
      artifacts: { enabled: true, namespace: "acme-context-collections" },
    },
    mcp: { enabled: true },
    github: { enabled: true },
    email: { enabled: true },
    customGatekeeper: { enabled: true, name: "Acme", message: "Use the company handbook." },
    errorReporting: { enabled: true, environment: "production", release: "abc123" },
    resources: {
      blueprintsKvNamespaceId: "blueprints-kv-id",
      avatarsKvNamespaceId: "avatars-kv-id",
      blueprintContentBucket: "acme-blueprints",
    },
    probe: { enabled: false },
  },

  minimal: {
    ...common(),
    publicBaseUrl: "https://acme-os.acme.workers.dev",
    workers: {
      router: { name: "acme-os", route: { workersDev: true } },
      workshop: { name: "acme-os-backend" },
      context: { name: "acme-os-context" },
      scheduler: { name: "acme-os-scheduler" },
    },
    aiGateway: { enabled: false },
    context: { sharingDomain: null, kvNamespaceId: null },
    mcp: { enabled: false },
    github: { enabled: false },
    email: { enabled: false },
    customGatekeeper: { enabled: false },
    errorReporting: { enabled: false },
    resources: {
      blueprintsKvNamespaceId: null,
      avatarsKvNamespaceId: null,
      blueprintContentBucket: null,
    },
    probe: { enabled: false },
  },

  likeThisDeployment: {
    ...common(),
    publicBaseUrl: null,
    workers: structuredClone(workers),
    aiGateway: {
      enabled: true,
      name: "acme-ai",
      accountId: null,
      providers: ["cloudflare", "anthropic"],
    },
    context: {
      sharingDomain: null,
      kvNamespaceId: "context-kv-id",
      artifacts: { enabled: true, namespace: "acme-context-collections" },
    },
    mcp: { enabled: true },
    github: { enabled: true },
    email: { enabled: false },
    customGatekeeper: { enabled: false, name: "Acme", message: "Use the company handbook." },
    errorReporting: { enabled: false, environment: "production", release: null },
    resources: {
      blueprintsKvNamespaceId: "blueprints-kv-id",
      avatarsKvNamespaceId: "avatars-kv-id",
      blueprintContentBucket: "acme-blueprints",
    },
    probe: { enabled: false },
  },
};
