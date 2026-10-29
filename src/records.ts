// The records a person adds at their DNS host, spelled the way that host wants them: the name
// relative to the zone, the root written as the host writes it, a CNAME's target with the dot
// some hosts need, a TXT value with the quotes some hosts need. A screen puts a copy button on
// each field, so a value here is exactly what gets pasted.
//
// Browser-safe.
import { DNS_HOSTS, trapOf, type DnsHostId } from "./hosts.ts";

export interface DnsRecordSpec {
  type: "CNAME" | "TXT" | "MX";
  /** The record's whole name: `help.acme.com`, `_dmarc.acme.com`, or the zone itself. */
  name: string;
  /** The target (CNAME, MX) or the text (TXT). `null` when no safe value is known. */
  value: string | null;
  /** The MX's priority. */
  priority?: number;
}

export interface DnsRecordRow {
  type: DnsRecordSpec["type"];
  /** The MX's priority; absent for every other type. */
  priority?: number;
  /** What goes in the name box. Empty: the host wants it left empty. */
  name: string;
  /** `null` when no safe value is known. */
  value: string | null;
  /** The record sits on the zone's own name, which hosts write in different ways. */
  atRoot: boolean;
  /** At the root, and no page of the host says how it writes it: `@` is a guess. */
  rootUnsure: boolean;
}

/** The part of `name` before `zone`: `t` for `t.acme.com` in `acme.com`, empty for the zone
 *  itself. A name outside the zone, or an unknown zone, stays whole. */
export function relativeName(name: string, zone: string | null): string {
  if (!zone) return name;
  if (name === zone) return "";
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/** The record's name relative to `zone`, with `@` for the zone itself. Null when the zone was not
 *  read. */
export function recordNameInZone(name: string, zone: string | null): string | null {
  if (!zone) return null;
  return relativeName(name, zone) || "@";
}

/** One record as `host` wants it typed. `host` and `zone` are `null` when we could not tell:
 *  the record then reads in the widest form (the whole name, `@` for the root, no quotes). */
export function dnsRecordRow(
  host: DnsHostId | null,
  zone: string | null,
  spec: DnsRecordSpec,
): DnsRecordRow {
  const data = host ? DNS_HOSTS[host] : null;
  const relative = relativeName(spec.name, zone);
  // A CNAME can't sit on the zone's own name; the other types can, and hosts write that name
  // in different ways.
  const atRoot = spec.type !== "CNAME" && relative === "";
  const name = atRoot ? (data?.root ?? "@") : relative || spec.name;
  if (spec.type === "CNAME" || spec.type === "MX") {
    // A host that adds the zone to a target without a final dot does it for an MX's too.
    const target =
      spec.value && data && trapOf(data, "trailingDot") ? `${spec.value}.` : spec.value;
    if (spec.type === "CNAME")
      return { type: "CNAME", name, value: target, atRoot: false, rootUnsure: false };
    return {
      type: "MX",
      name,
      value: target,
      priority: spec.priority,
      atRoot,
      rootUnsure: atRoot && (!data || data.root === null),
    };
  }
  return {
    type: "TXT",
    name,
    value: spec.value && data && trapOf(data, "quotedTxt") ? `"${spec.value}"` : spec.value,
    atRoot,
    rootUnsure: atRoot && (!data || data.root === null),
  };
}
