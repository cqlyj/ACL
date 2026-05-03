/**
 * Quickstart configuration. One file you skim before reading any agent
 * code, so the demo's "what's wired where" is obvious at a glance:
 *
 *   - `env`         — `.env` reader + private-key parsers (no SDK).
 *   - `BRIEF`       — the prompt the client sends to the provider.
 *   - `TASK_DOMAINS`— the gateway-side filter; intentionally a unique
 *                     string so the quickstart provider is the *only*
 *                     candidate `searchAgents()` returns.
 *   - `MAX_BUDGET` / `PROVIDER_MIN_BUDGET` — the negotiation envelope.
 *   - personas      — short LLM character prompts for client + provider.
 *
 * The quickstart's `.env` is authoritative — values set there override
 * the parent shell environment (the repo-root Makefile's `include .env /
 * export` would otherwise leak `PROVIDER_ENS_LABEL` etc. into Bun).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";

const ENV_FILE = resolve(import.meta.dir, "..", ".env");
if (existsSync(ENV_FILE)) {
  const text = readFileSync(ENV_FILE, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function read(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

function require(key: string): string {
  const v = read(key);
  if (!v)
    throw new Error(
      `quickstart: ${key} is required (set it in examples/quickstart/.env)`,
    );
  return v;
}

function privateKey(key: string): Hex {
  const v = require(key);
  if (!v.startsWith("0x") || v.length !== 66) {
    throw new Error(
      `quickstart: ${key} must be a 0x-prefixed 32-byte hex string`,
    );
  }
  return v as Hex;
}

export const env = {
  galileoRpcUrl: read("GALILEO_RPC_URL") ?? "https://evmrpc-testnet.0g.ai",
  sepoliaRpcUrl: read("SEPOLIA_RPC_URL"),
  clientPk: () => privateKey("CLIENT_PRIVATE_KEY"),
  providerPk: () => privateKey("PROVIDER_PRIVATE_KEY"),
  evaluatorOperatorPk: () => privateKey("EVALUATOR_OPERATOR_PRIVATE_KEY"),
  evaluatorOwnerPk: (): Hex | undefined => {
    const v = read("EVALUATOR_OWNER_PRIVATE_KEY");
    return v ? (v as Hex) : undefined;
  },
  providerEnsLabel: read("PROVIDER_ENS_LABEL") ?? "quickstart-greeter",
  zgRouterApiKey: () => require("ZG_ROUTER_API_KEY"),
  zgRouterModel: read("ZG_ROUTER_MODEL") ?? "qwen-2.5-7b-instruct",
  zgRouterBaseUrl: read("ZG_ROUTER_BASE_URL"),
  gatewayUrl: () => require("GATEWAY_URL"),
  axlBin: read("AXL_BIN") ?? "../../axl/node",
};

/**
 * Unique quickstart task-domain. The gateway's `searchAgents` does
 * substring matching on `acl.task-domains`, so registering greeter
 * under a string that no other agent on the live testnet uses
 * guarantees `searchAgents({ taskDomain: "quickstart-greeting" })`
 * returns exactly one candidate — no negotiation fallback dance.
 */
export const TASK_DOMAINS = ["quickstart-greeting"] as const;

/** What the client LLM is allowed to pick from. Mirrors `TASK_DOMAINS`
 * so the LLM has exactly one legal choice and discovery is
 * deterministic on first try. */
export const ALLOWED_DOMAINS = TASK_DOMAINS;

/** ENSIP-26 capability tokens the provider advertises. */
export const CAPABILITIES = ["commission"] as const;

/** The user-prompt the client commissions. Tuned to the testnet
 * `qwen-2.5-7b-instruct` model: simple, single sentence, hard to
 * mis-parse on either side. */
export const BRIEF =
  "Write a short, friendly two-line greeting that says hello to the ACL community.";

/** Hard budget ceiling on the client side (2 testUSDC, 6 decimals). */
export const MAX_BUDGET = 2_000_000n;

/** Provider-side floor on the same scale. The negotiation legal range
 * is `[PROVIDER_MIN_BUDGET, MAX_BUDGET]`. */
export const PROVIDER_MIN_BUDGET = 1_000_000n;

export const CLIENT_PERSONA =
  "You are a curious end user requesting a friendly hello-world poem.";

export const PROVIDER_PERSONA =
  "You are a friendly autonomous greeter. Keep replies short and warm.";
