import { type Hex, hexToBytes } from "viem";

/**
 * Decode a DNS-encoded ENS name (`<len><label><len><label>...<00>`) into its
 * label array + dotted form. Returns lowercase labels because ENS names are
 * UTS46-normalised lowercase by the time they reach a resolver.
 *
 * @example
 *   decodeDnsName('0x0a726573656172636865720361636c036574680000')
 *   // → { labels: ['researcher', 'acl', 'eth'], name: 'researcher.acl.eth' }
 */
export function decodeDnsName(dnsHex: Hex): { labels: string[]; name: string } {
  const buf = hexToBytes(dnsHex);
  const labels: string[] = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i]!;
    if (len === 0) break;
    const start = i + 1;
    const end = start + len;
    if (end > buf.length) {
      throw new Error("decodeDnsName: truncated label runs past end of buffer");
    }
    const label = new TextDecoder().decode(buf.slice(start, end));
    labels.push(label.toLowerCase());
    i = end;
  }
  return { labels, name: labels.join(".") };
}

/**
 * Strip a parent suffix (e.g. `acl.eth`) from a DNS-decoded name and return
 * the leading sub-portion, or `null` if the name IS the parent itself.
 *
 * The return value can contain multiple labels (e.g. `'sub.foo'` when the
 * input is `'sub.foo.acl.eth'`); callers that only honour single-label
 * children (the ACL registry's model: one agent per label, no inherited
 * subnames) MUST gate that with {@link isSingleLabel} so deep subnames
 * fall through to "no record" instead of being misinterpreted.
 */
export function subLabelUnder(name: string, parent: string): string | null {
  const lname = name.toLowerCase();
  const lparent = parent.toLowerCase();
  if (lname === lparent) return null;
  const suffix = `.${lparent}`;
  if (!lname.endsWith(suffix)) {
    throw new Error(`subLabelUnder: '${name}' is not under '${parent}'`);
  }
  return lname.slice(0, -suffix.length);
}

/**
 * True iff `s` is exactly one ENS label (no `.` separator). Used by the
 * resolver service to reject deep subnames like `sub.foo.acl.eth` whose
 * sub-portion (`sub.foo`) is not a registry label.
 */
export function isSingleLabel(s: string): boolean {
  return s.length > 0 && !s.includes(".");
}
