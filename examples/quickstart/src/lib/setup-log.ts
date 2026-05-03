/**
 * Tiny progress logger for `setup.ts`. The setup script is otherwise
 * silent for ~25–30s while `registerAclAgent` mints the agent and runs
 * 10 sequential `setMetadata` calls — long enough that a fresh user
 * thinks the demo hung. This helper produces structured before / after
 * lines with elapsed-second tags so the operator sees forward motion.
 *
 *   [setup    ]   ENS label: quickstart-greeter.acl.eth
 *   [setup    ] → [0s]  spawning provider AXL bridge briefly…
 *   [setup    ] ✓ [3s]  AXL peer id = c8af07131118…
 *   [setup    ] → [3s]  registering on ACLIdentityRegistry (mint + 10 setMetadata, ~30s)…
 *   [setup    ] ✓ [33s] agentId=7 (reused)
 *   [setup    ]     tx https://chainscan-galileo.0g.ai/tx/0x…
 *   …
 */
const TAG = "[setup    ]";
const EXPLORER_PREFIX = "https://chainscan-galileo.0g.ai/tx/";

export function setupLog() {
  const start = Date.now();
  const elapsed = () =>
    `${Math.floor((Date.now() - start) / 1000)}s`.padStart(3, " ");
  return {
    /** Loose informational line, no timestamp. */
    info: (msg: string) => console.log(`${TAG}   ${msg}`),
    /** Step start. Reads `→ [Ns] doing …`. */
    step: (msg: string) => console.log(`${TAG} → [${elapsed()}] ${msg}…`),
    /** Step OK. Reads `✓ [Ns] done`. */
    ok: (msg: string) => console.log(`${TAG} ✓ [${elapsed()}] ${msg}`),
    /** Tx hash echo with explorer link. */
    tx: (h: string) => console.log(`${TAG}     tx ${EXPLORER_PREFIX}${h}`),
  };
}
