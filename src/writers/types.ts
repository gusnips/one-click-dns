// What every token writer shares: one record in, one outcome out, and a closed list of reasons it
// can fail. The app words each reason in its own languages; nothing here is meant to be shown.
import type { DnsHostId } from "../hosts.ts";

export interface DnsWriteRecord {
  type: "CNAME" | "TXT";
  /** The record's whole name: `help.acme.com`. */
  name: string;
  /** The target (CNAME) or the text (TXT), as the app means it, with no quotes added. */
  value: string;
}

/**
 * - `created`: the record is there now;
 * - `unchanged`: the same record was already there;
 * - `unproxied`: the same record was there behind the host's proxy, and the proxy is off now,
 *   because a proxied record hides the CNAME a checker reads (Cloudflare).
 */
export type DnsWriteOutcome = "created" | "unchanged" | "unproxied";

/**
 * Why a write was refused. A person can act on each one:
 * - `token_invalid`: the host didn't accept the token (paste it again);
 * - `zone_read_missing`: the token can't list the domains (give it that permission);
 * - `dns_edit_missing`: the token can't change DNS records (give it that permission);
 * - `zone_not_found`: no zone the token can see holds the name (the domain is elsewhere, or the
 *   token is for another account);
 * - `conflict`: the name already has a record that isn't ours, and it is the owner's to resolve;
 * - `unavailable`: the host didn't answer in a usable way (try again).
 */
export type DnsWriteErrorCode =
  | "token_invalid"
  | "zone_read_missing"
  | "dns_edit_missing"
  | "zone_not_found"
  | "conflict"
  | "unavailable";

/** A refusal with a fixed message and no `cause`: an error from the host or from `fetch` can
 *  quote the token, so none of it is kept. */
export class DnsWriteError extends Error {
  constructor(
    readonly code: DnsWriteErrorCode,
    /** `conflict` carries `hostname` and the `type` of the record in the way. */
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(MESSAGES[code](params));
    this.name = "DnsWriteError";
  }
}

const MESSAGES: Record<DnsWriteErrorCode, (params: Readonly<Record<string, string>>) => string> = {
  token_invalid: () => "The DNS host didn't accept that token",
  zone_read_missing: () => "That token can't read your domains",
  dns_edit_missing: () => "That token can't change DNS records",
  zone_not_found: (p) => `No zone holds ${p.hostname ?? "that name"}`,
  conflict: (p) =>
    `${p.hostname ?? "That name"} already has a record${p.type ? ` (type ${p.type})` : ""}`,
  unavailable: () => "Couldn't reach the DNS host",
};

export interface DnsWriter {
  host: DnsHostId;
  /** Add the record to the person's own zone with a token they pasted. The token lives only in
   *  this call: it is never stored, queued, logged, put in a URL or put in an error. A record
   *  the person already has is never overwritten or deleted. */
  addRecord(input: {
    token: string;
    record: DnsWriteRecord;
    /** Shown beside the record in the host's panel, where the host has such a field. */
    comment?: string;
    fetch?: typeof fetch;
  }): Promise<DnsWriteOutcome>;
}
