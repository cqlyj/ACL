import type { NegotiationMessage } from "./messages.js";

export type TranscriptDirection = "sent" | "received";

export type TranscriptEntry = {
  direction: TranscriptDirection;
  /** Peer the message went to (sent) or came from (received). */
  peerId: string;
  /** Wall-clock time the entry was added (ISO-8601). */
  loggedAt: string;
  message: NegotiationMessage;
};

/**
 * In-memory append-only log of negotiation messages. Both parties keep their
 * own transcript; comparing them after a round-trip lets us prove that no
 * message was altered in transit.
 *
 * `export()` returns a JSON-serialisable snapshot suitable for archival
 * (e.g. uploading to 0G Storage with the dual-signed JobProposal hash).
 */
export class Transcript {
  private readonly entries: TranscriptEntry[] = [];

  add(direction: TranscriptDirection, peerId: string, message: NegotiationMessage): void {
    this.entries.push({
      direction,
      peerId,
      loggedAt: new Date().toISOString(),
      message,
    });
  }

  size(): number {
    return this.entries.length;
  }

  /** Defensive copy. */
  list(): readonly TranscriptEntry[] {
    return [...this.entries];
  }

  /**
   * Snapshot suitable for `JSON.stringify`. Includes the negotiation
   * protocol version + a count for quick sanity-checking.
   */
  export(): {
    protocol: string;
    version: number;
    count: number;
    entries: TranscriptEntry[];
  } {
    return {
      protocol: "acl.axl.transcript",
      version: 1,
      count: this.entries.length,
      entries: [...this.entries],
    };
  }
}
