// What every token writer decides the same way, whatever the host's API looks like: which names to
// try as the zone, and what to do given the records already at the name. The rule is the same
// everywhere: never overwrite or delete a record the person already has.
import { normalizeDnsName } from "../dns-name.ts";
import { DnsWriteError, type DnsWriteRecord } from "./types.ts";

export interface ExistingRecord {
  id: string;
  type: string;
  content: string;
  /** The record's whole name, for a host that lists every record of the zone and not just the
   *  ones at one name. */
  name?: string;
  /** Only a host with a proxy (Cloudflare) says. */
  proxied?: boolean;
}

/** The name and its parents, closest first, down to two labels: help.acme.co.uk asks
 *  help.acme.co.uk (a zone of its own, delegated), then acme.co.uk, never co.uk. */
export function zoneCandidates(hostname: string): string[] {
  const labels = hostname.split(".");
  const names: string[] = [];
  for (let start = 0; start < labels.length - 1; start++) names.push(labels.slice(start).join("."));
  return names;
}

/** What a host answers for a TXT: the text, sometimes wrapped in quotes, split into 255-byte
 *  strings past that. Compared as the text. */
// ponytail: read as the dashboards show it; confirm against a live zone before relying on it.
const unquoted = (content: string) => content.replace(/"\s+"/g, "").replace(/^"|"$/g, "");

/** Whether `existing` holds the value `record` means, ignoring case and a final dot (CNAME) or
 *  the quotes around the text (TXT). */
export const sameValue = (record: DnsWriteRecord, existing: Pick<ExistingRecord, "content">) =>
  record.type === "CNAME"
    ? normalizeDnsName(existing.content) === normalizeDnsName(record.value)
    : unquoted(existing.content) === record.value;

/** A name keeps one SPF record, so a second one at it is a conflict, not an addition. */
const isSpf = (text: string) => /^v=spf1(?:\s|$)/i.test(unquoted(text).trim());

/** Whether `existing` keeps `record` from being added. A CNAME stands alone at its name, and a
 *  TXT can't sit beside one; TXT records beside TXT records are fine, except a second SPF. */
function blocks(record: DnsWriteRecord, existing: ExistingRecord): boolean {
  if (record.type === "CNAME" || existing.type === "CNAME") return true;
  return existing.type === "TXT" && isSpf(record.value) && isSpf(existing.content);
}

export type Decision =
  | { kind: "unchanged" }
  /** The same CNAME is there behind the host's proxy: turn the proxy off. */
  | { kind: "unproxy"; id: string }
  | { kind: "create" };

/** Given every record already at the name, what to do. Throws `conflict` when another record
 *  keeps ours from being added. */
export function decide(
  record: DnsWriteRecord,
  existing: readonly ExistingRecord[],
  hostname: string,
): Decision {
  const ours = existing.find((r) => r.type === record.type && sameValue(record, r));
  if (ours) {
    if (record.type === "CNAME" && ours.proxied === true) return { kind: "unproxy", id: ours.id };
    return { kind: "unchanged" };
  }
  const blocker = existing.find((r) => blocks(record, r));
  if (blocker) throw new DnsWriteError("conflict", { hostname, type: blocker.type });
  return { kind: "create" };
}
