// 0G Storage explorer is keyed by submission txSeq (the SDK surfaces
// this on every `storage.upload` event), NOT by Merkle root — a
// `/file?root=<hash>` URL would 404. Use `storageSubmissionLink` for
// every linkable storage payload; render bare root hashes verbatim.
export const STORAGE_SCAN_BASE = "https://storagescan-galileo.0g.ai";
export const GALILEO_SCAN_BASE = "https://chainscan-galileo.0g.ai";
export const SEPOLIA_SCAN_BASE = "https://sepolia.etherscan.io";

const _CHAIN_LABELS = {
  16602: { label: "galileo tx", base: GALILEO_SCAN_BASE },
  11155111: { label: "sepolia tx", base: SEPOLIA_SCAN_BASE },
};

/**
 * Returns `{ label, url }` for a transaction link. Centralises the
 * "which explorer base belongs to which chainId" decision so call
 * sites don't have to repeat the chainId switch (and so adding a new
 * chain only touches `_CHAIN_LABELS`).
 *
 * Falls back to the Galileo explorer with a generic `tx` label for
 * unknown chains — the URL might 404 but the link still renders.
 */
export function txLink(chainId, txHash) {
  const entry = _CHAIN_LABELS[chainId];
  if (entry) {
    return { label: entry.label, url: `${entry.base}/tx/${txHash}` };
  }
  return { label: "tx", url: `${GALILEO_SCAN_BASE}/tx/${txHash}` };
}

export function storageSubmissionLink(txSeq) {
  return `${STORAGE_SCAN_BASE}/submission/${txSeq}`;
}
