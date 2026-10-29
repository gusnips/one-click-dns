// Where a domain's DNS lives: the zone's name servers, read from DNS, and the host they mean
// (`detectDnsHosts`). Used to tell a person which page to open to add a record, and to choose
// how to write it for them.
//
// One walk up from the name, asking for NS records until a name answers: `t.acme.com`, then
// `acme.com`, never the one-label top level. Measured on Node 24.21 and Bun 1.4.2 (2026-10-05):
// a zone's apex answers its NS; a name below it answers ENODATA on Node and ENOTFOUND on Bun,
// both "nothing here".
//
// Two rules from the DNS checks next door. A lookup DNS did not answer is its own result and
// ends the walk with `null`: never "no host", because a customer on a host we know would read
// that as "we don't know yours". And a resolver follows a CNAME to answer an NS question, so a
// name that holds a CNAME would return the name servers of wherever it leads: the walk asks
// `cname` after an answer and goes on up when there is one.
import { normalizeDnsName } from "../dns-name.ts";
import { detectDnsHosts, type DnsHostReading, type DnsZone } from "../hosts.ts";
import type { DnsLookups } from "./dns.ts";

export type ZoneLookups = Pick<DnsLookups, "cname" | "ns">;

/** The reading for a zone read from DNS. The host is worked out here, on every read, so a stored
 *  zone follows the table when a pattern is added. */
export function dnsHostOf(zone: DnsZone): DnsHostReading {
  return { ...zone, hosts: detectDnsHosts(zone.nameservers) };
}

/**
 * The nearest zone at or above `hostname` that has name servers of its own, or `null` when DNS
 * did not answer, no name up the tree has any, or the walk ran past `budgetMs`. A slow resolver
 * costs the caller its budget and no more.
 */
export async function readDnsZone(
  lookups: ZoneLookups,
  hostname: string,
  budgetMs: number,
): Promise<DnsZone | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    return await Promise.race([walk(lookups, hostname), outOfTime]);
  } finally {
    clearTimeout(timer);
  }
}

async function walk(lookups: ZoneLookups, hostname: string): Promise<DnsZone | null> {
  const labels = normalizeDnsName(hostname).split(".");
  for (let start = 0; start < labels.length - 1; start++) {
    const zone = labels.slice(start).join(".");
    const answer = await lookups.ns(zone);
    if (answer === "failed") return null;
    if (answer === "absent" || !answer.names.length) continue;
    const alias = await lookups.cname(zone);
    if (alias === "failed") return null;
    if (alias !== "absent") continue;
    return { zone, nameservers: [...new Set(answer.names.map(normalizeDnsName))].sort() };
  }
  return null;
}
