import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACL_TESTNET } from "@acl/agent";
import type { Address } from "viem";

/**
 * Centralised env loader. All env vars are read here so call-sites
 * can stay declarative and any missing key fails fast at boot rather
 * than mid-flow.
 *
 * We deliberately make the local `.env` file *authoritative*: any value
 * defined there clobbers a same-named shell variable inherited from the
 * parent process. This avoids the easy footgun where the developer has
 * sourced the repo-root `.env` earlier (with its CCIP-Read template
 * `GATEWAY_URL=http://localhost:3000/{sender}/{data}.json`) and is then
 * confused when the example agents fetch the wrong URL. Bun's default
 * env-file loading gives shell vars priority — see
 * https://bun.sh/docs/runtime/env — so we patch `process.env` ourselves
 * before anything else reads from it.
 */
function _loadDotenvOverrides(): void {
  // Resolve the example app root (one level up from `src/`).
  const here = new URL(".", import.meta.url).pathname;
  const envPath = resolve(here, "..", ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding double or single quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

_loadDotenvOverrides();

function require_(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`@kelp-postmortem: missing env var ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const config = {
  galileoRpcUrl: optional("GALILEO_RPC_URL") ?? ACL_TESTNET.galileo.rpcUrl,
  sepoliaRpcUrl: optional("SEPOLIA_RPC_URL"),

  clientPrivateKey: () => require_("CLIENT_PRIVATE_KEY") as `0x${string}`,
  providerSecurityPrivateKey: () =>
    require_("PROVIDER_SECURITY_PRIVATE_KEY") as `0x${string}`,
  providerGeneralistPrivateKey: () =>
    require_("PROVIDER_GENERALIST_PRIVATE_KEY") as `0x${string}`,
  evaluatorOperatorPrivateKey: () =>
    require_("EVALUATOR_OPERATOR_PRIVATE_KEY") as `0x${string}`,
  evaluatorOwnerPrivateKey: () =>
    optional("EVALUATOR_OWNER_PRIVATE_KEY") as `0x${string}` | undefined,

  providerSecurityEnsLabel:
    optional("PROVIDER_SECURITY_ENS_LABEL") ?? "kelp-security",
  providerGeneralistEnsLabel:
    optional("PROVIDER_GENERALIST_ENS_LABEL") ?? "kelp-generalist",

  zgRouterApiKey: () => require_("ZG_ROUTER_API_KEY"),
  zgRouterModel: optional("ZG_ROUTER_MODEL") ?? "qwen-2.5-7b-instruct",
  zgRouterBaseUrl: optional("ZG_ROUTER_BASE_URL"),

  gatewayUrl: () => require_("GATEWAY_URL"),

  port: Number(optional("PORT") ?? "8787"),

  // `./node` matches the new SDK default (Section 3.3) so a fresh
  // `.env` clone Just Works against the AXL Go binary in cwd. The
  // example's `spawnAxlBridge` calls inherit this value verbatim.
  axlBin: optional("AXL_BIN") ?? "./node",

  kelpSourceRoot: () =>
    optional("KELP_SOURCE_ROOT") as `0x${string}` | undefined,

  // ----- Flow 2 (iNFT Commerce) ------------------------------------
  demoOraclePrivateKey: () =>
    optional("DEMO_ORACLE_PRIVATE_KEY") as `0x${string}` | undefined,

  deployment: ACL_TESTNET,
  paymentToken: ACL_TESTNET.galileo.testUSDC as Address,
} as const;

/**
 * Loopback URL the child agent processes use to forward events
 * back to the coordinator HTTP server. Centralised here so the
 * three agent processes don't drift from `http://127.0.0.1:${port}`.
 */
export const COORDINATOR_URL = `http://127.0.0.1:${config.port}` as const;

/**
 * AXL bridge layout. Each agent gets its own bridge; that means a
 * unique HTTP `apiPort` and a unique TLS `listenPort` so the three
 * bridges can coexist on `localhost`.
 *
 * The `tcpPort` (the virtual port inside AXL's gVisor/Yggdrasil
 * overlay) MUST be identical across the mesh because the dialer
 * uses its own `tcp_port` as the destination port — that's how the
 * upstream `axl/configs/node-{a,b}.json` files are wired (both pin
 * `tcp_port: 7000`). Pick one shared value for the demo.
 */
export const AXL_OVERLAY_TCP_PORT = 7000;
export const AXL_BRIDGES = {
  client: { apiPort: 9101, listenPort: 9201, tcpPort: AXL_OVERLAY_TCP_PORT },
  providerSecurity: {
    apiPort: 9102,
    listenPort: 9202,
    tcpPort: AXL_OVERLAY_TCP_PORT,
  },
  providerGeneralist: {
    apiPort: 9103,
    listenPort: 9203,
    tcpPort: AXL_OVERLAY_TCP_PORT,
  },
} as const;

/**
 * Provider flavour catalogue. Single source of truth for the
 * Kelp-postmortem demo's two provider personas — consumed by both
 * `scripts/register-providers.ts` (mints + writes ENSIP-26 metadata)
 * and `src/agents/provider-process.ts` (runtime persona / accept
 * policy / source-tag). Adding a provider flavour means editing this
 * map only.
 */
export type ProviderFlavour = "security" | "generalist";

export type ProviderSpec = {
  flavour: ProviderFlavour;
  privateKey: () => `0x${string}`;
  ensLabel: string;
  axl: { apiPort: number; listenPort: number; tcpPort: number };
  /** Comma-target task domains advertised on chain. */
  taskDomains: readonly string[];
  /** Commission floor for Flow-1 (`deliveryType: 'text'`) jobs. */
  minBudget: bigint;
  /** iNFT sale floor for Flow-2 (`deliveryType: 'iNFT'`) jobs. */
  iNftSalePrice: bigint;
  /** Provider persona, fed verbatim into the LLM system prompt. */
  persona: string;
  /** Source-tag used by the coordinator's event forwarder. */
  source: "provider-security" | "provider-generalist";
};

export const PROVIDER_SPECS: Readonly<Record<ProviderFlavour, ProviderSpec>> = {
  security: {
    flavour: "security",
    privateKey: config.providerSecurityPrivateKey,
    ensLabel: config.providerSecurityEnsLabel,
    axl: AXL_BRIDGES.providerSecurity,
    taskDomains: ["security", "research"],
    minBudget: 50_000_000n, // 50 testUSDC (6 decimals)
    iNftSalePrice: 25_000_000n, // 25 testUSDC
    persona: [
      "You are a smart-contract security specialist who has audited cross-chain bridges including LayerZero, Axelar, and Wormhole.",
      "You write exploit post-mortems that read like an audit report: precise terminology, concrete trust assumptions, references to specific contract functions and packet/messaging primitives.",
    ].join(" "),
    source: "provider-security",
  },
  generalist: {
    flavour: "generalist",
    privateKey: config.providerGeneralistPrivateKey,
    ensLabel: config.providerGeneralistEnsLabel,
    axl: AXL_BRIDGES.providerGeneralist,
    taskDomains: ["general", "research"],
    minBudget: 30_000_000n,
    iNftSalePrice: 15_000_000n,
    persona: [
      "You are a generalist crypto researcher and explainer. You write clear post-mortems aimed at a wide DeFi audience.",
      "You prioritise accessibility over deep technical detail; you cover impact, affected protocols, and macro implications.",
    ].join(" "),
    source: "provider-generalist",
  },
} as const;
