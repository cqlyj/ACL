import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { AxlBridge } from "./bridge.js";
import {
  ACL_NEGOTIATION_PROTOCOL,
  type NegotiationMessage,
  type RejectMessage,
  makeEnvelope,
} from "./messages.js";
import { Negotiator } from "./negotiator.js";
import { buildJobProposalDomain } from "@acl/core";

const TEST_DOMAIN = buildJobProposalDomain({
  chainId: 16_602,
  agenticCommerce: "0x38A5c19134C1a922E52eBd3c3F96eBb47f5582B4",
});

/** Build a `Negotiator` whose AXL bridge is wired to a programmable fetch. */
function makeNegotiator(
  messages: ReadonlyArray<NegotiationMessage>,
): Negotiator {
  const queue: NegotiationMessage[] = [...messages];
  const fetchImpl: typeof fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/recv")) {
      const next = queue.shift();
      if (!next) {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-from-peer-id": "deadbeef".repeat(8),
        },
      });
    }
    return new Response("not implemented", { status: 500 });
  }) as typeof fetch;
  const bridge = new AxlBridge({
    apiUrl: "http://test",
    pollIntervalMs: 10,
    fetch: fetchImpl,
  });
  // Hand-build a Negotiator tied to that bridge — re-using the
  // constructor would create its own bridge, defeating the fake.
  const account = privateKeyToAccount(
    "0x40678d56fbebb4b14075ad5e813ee36d017039d041ba25401c8c0be8111cfc90",
  );
  const negotiator = new Negotiator({
    apiUrl: "http://test",
    signer: account,
    fetch: fetchImpl,
    domain: TEST_DOMAIN,
  });
  // Replace the auto-built bridge with the one bound to our fake fetch
  // so messages we shoved into `queue` are what `recv` returns.
  Object.defineProperty(negotiator, "bridge", { value: bridge });
  return negotiator;
}

describe("Negotiator.waitForOneOf — replyToId filter", () => {
  test("matches the message whose replyTo equals the requested id", async () => {
    // Two REJECTs ride the inbox: one is a stale reply to a previous
    // round (replyTo === 'old-thread'), one is fresh (replyTo === 'p1').
    const stale = makeEnvelope<RejectMessage>(
      "REJECT",
      { reason: "stale" },
      { id: "stale-id", replyTo: "old-thread" },
    );
    const fresh = makeEnvelope<RejectMessage>(
      "REJECT",
      { reason: "fresh" },
      { id: "fresh-id", replyTo: "p1" },
    );
    const n = makeNegotiator([stale, fresh]);
    const got = await n.waitForOneOf(["REJECT"], {
      replyToId: "p1",
      timeoutMs: 1_000,
    });
    expect(got.payload.reason).toBe("fresh");
    expect(got.replyTo).toBe("p1");
    // The stale envelope must have ended up on the transcript so a UI
    // / audit log can still see it (the negotiator must NOT silently
    // drop traffic).
    const recorded = n.transcript
      .list()
      .find((r) => r.message.id === "stale-id");
    expect(recorded?.direction).toBe("received");
    expect(recorded?.message.type).toBe("REJECT");
  });

  test("times out when no message replies to the requested id", async () => {
    const stale = makeEnvelope<RejectMessage>(
      "REJECT",
      {},
      { id: "stale", replyTo: "old-thread" },
    );
    const n = makeNegotiator([stale]);
    await expect(
      n.waitForOneOf(["REJECT"], {
        replyToId: "p1",
        timeoutMs: 250,
      }),
    ).rejects.toThrow(/recv timeout/);
    // Same transcript guarantee in the timeout path.
    const recorded = n.transcript.list().find((r) => r.message.id === "stale");
    expect(recorded?.direction).toBe("received");
  });

  test("legacy callers (no replyToId) match by type only", async () => {
    const accept = makeEnvelope(
      "ACCEPT",
      {
        proposal: {
          client: `0x${"11".repeat(20)}`,
          provider: `0x${"22".repeat(20)}`,
          evaluator: `0x${"33".repeat(20)}`,
          paymentToken: `0x${"44".repeat(20)}`,
          amount: "1",
          hook: `0x${"55".repeat(20)}`,
          taskSpecHash: `0x${"ee".repeat(32)}` as `0x${string}`,
          expiresAt: "1900000000",
          nonce: `0x${"11".repeat(32)}` as `0x${string}`,
        },
        signer: `0x${"aa".repeat(20)}` as `0x${string}`,
        signature: `0x${"bb".repeat(65)}` as `0x${string}`,
      },
      { id: "a-id", replyTo: "anything" },
    );
    const n = makeNegotiator([accept]);
    const got = await n.waitForOneOf(["ACCEPT"], {
      timeoutMs: 1_000,
    });
    expect(got.type).toBe("ACCEPT");
  });
});

void ACL_NEGOTIATION_PROTOCOL;
