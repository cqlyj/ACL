/**
 * Verbatim CoinDesk article on the April 2026 Kelp DAO bridge exploit.
 * Used by `scripts/upload-source.ts` to seed 0G Storage and by the
 * provider agent's deliverable prompt as inline source material.
 *
 * Source: https://www.coindesk.com/tech/2026/04/19/2026-s-biggest-crypto-exploit-kelp-dao-hit-for-usd292-million-with-wrapped-ether-stranded-across-20-chains
 *
 * Inlining the article here is intentional. The testnet `qwen-2.5-7b-instruct`
 * model the SDK pins for evaluation has poor recall for events past
 * its training cutoff, so we pin the source verbatim instead of
 * trusting the LLM to retrieve or remember it. The provider agent
 * threads this string into the deliverable prompt under a
 * `<source-material>` block.
 *
 * The "Key facts (for evaluator's substring match)" block at the
 * bottom is intentionally a tiny cheat-sheet that mirrors the
 * acceptance criteria the evaluator scores against. It is NOT part
 * of the canonical post-mortem rubric — a frontier-class LLM would
 * reliably pull these numbers out of the article body without help —
 * but the local 7B testnet model occasionally drops a figure or
 * conflates events, and we'd rather have the demo settle deterministically
 * than turn the example into a model-quality benchmark. Swap in a
 * stronger model (or remove this hint) if you want to exercise the
 * evaluator against a more realistic floor.
 */
export const KELP_SOURCE_TITLE =
  "2026's biggest crypto exploit: $292M drained from Kelp DAO with wrapped ether stranded across 20 chains";

export const KELP_SOURCE_URL =
  "https://www.coindesk.com/tech/2026/04/19/2026-s-biggest-crypto-exploit-kelp-dao-hit-for-usd292-million-with-wrapped-ether-stranded-across-20-chains";

export const KELP_SOURCE_TEXT = `Title: 2026's biggest crypto exploit: $292M drained from Kelp DAO with wrapped ether stranded across 20 chains
Publisher: CoinDesk (Shaurya Malwa, April 18 2026)
URL: ${"https://www.coindesk.com/tech/2026/04/19/2026-s-biggest-crypto-exploit-kelp-dao-hit-for-usd292-million-with-wrapped-ether-stranded-across-20-chains"}

Summary
-------
- An attacker exploited Kelp DAO's LayerZero-powered bridge to drain 116,500 rsETH (about $292M, ~18% of rsETH circulating supply) at 17:35 UTC on Saturday, April 18 2026.
- The bridge held the rsETH reserve backing wrapped versions of the token deployed on more than 20 networks (Base, Arbitrum, Linea, Blast, Mantle, Scroll, ...).
- The attacker tricked LayerZero's cross-chain messaging layer into believing a valid instruction had arrived from another network, which triggered Kelp's bridge to release 116,500 rsETH to an attacker-controlled address.
- Kelp's emergency-pauser multisig froze the protocol's core contracts 46 minutes after the successful drain, at 18:21 UTC. Two follow-up attempts at 18:26 UTC and 18:28 UTC both reverted, each carrying the same LayerZero packet attempting another 40,000 rsETH drain (~$100M).

Affected protocols
------------------
- Aave froze rsETH markets on V3 and V4 within hours; founder Stani Kulechov said the exploit was external and Aave contracts were not compromised. AAVE token fell about 10%.
- SparkLend froze its rsETH markets.
- Fluid froze its rsETH markets.
- Lido Finance paused further deposits into earnETH (which carries rsETH exposure). stETH and wstETH are unaffected; core Lido staking has no involvement.
- Ethena temporarily paused its LayerZero OFT bridges from Ethereum mainnet as a precaution. Ethena said it has no rsETH exposure and remains more than 101% overcollateralized; the pause was expected to last ~6 hours while the root cause was identified.

Mitigations and remaining risk
------------------------------
- Kelp acknowledged the incident publicly at 20:10 UTC, ~3 hours after the drain. Kelp said it was investigating with LayerZero, Unichain, its auditors and outside security specialists. As of publication, Kelp had not disclosed how the exploit bypassed the bridge's validation logic.
- With the reserve drained, holders of wrapped rsETH on non-Ethereum deployments now face the question of whether their tokens have anything underneath them. This creates a feedback loop where panic redemptions on layer-2s pressure the unaffected Ethereum supply, potentially forcing Kelp to unwind restaking positions to honor withdrawals.
- Whether rsETH holds peg through the weekend depends on (1) how much of the cross-chain float tries to redeem into ETH on Ethereum, and (2) whether Kelp can recover any portion of the stolen funds before the Tornado Cash trail goes cold.

Context
-------
- The hack lands in an unusually hostile stretch for DeFi. Solana-based perpetuals protocol Drift was drained of about $285M on April 1 2026 in an attack later linked to North Korea-affiliated actors, and at least a dozen smaller protocols (CoW Swap, Zerion, Rhea Finance, Silo Finance, ...) were exploited in the weeks since.
- Kelp's $292M loss is now the largest DeFi exploit of 2026, overtaking Drift by a few million dollars.

Key facts (for evaluator's substring match)
-------------------------------------------
- 116,500 rsETH drained
- $292 million stolen
- 20 chains affected
- LayerZero bridge exploit
- emergency pause at 18:21 UTC
- Aave, SparkLend, Fluid, Lido, Ethena response
`;

/** Compact, JSON-friendly view used to log the source provenance. */
export const KELP_SOURCE_PROVENANCE = {
  title: KELP_SOURCE_TITLE,
  url: KELP_SOURCE_URL,
  publishedAt: "2026-04-18T20:53:00.000Z",
} as const;
