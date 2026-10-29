// "Connect with DigitalOcean": add a record to the person's own DigitalOcean domain, with an API
// token they paste once. The token needs the `domain:read` and `domain:create` scopes (or full
// access). It lives only in this call's stack: it goes in the Authorization header, never in a
// URL, and never reaches an error. Every refusal is a `DnsWriteError` with a fixed message,
// never DigitalOcean's own words.
//
// Spec read 2026-10-29: https://github.com/digitalocean/openapi (domains resources). A CNAME's
// target must end with a dot, or DigitalOcean adds the domain to it.
import { fetchBounded } from "../bounded-fetch.ts";
import { normalizeDnsName } from "../dns-name.ts";
import { isObject } from "../guards.ts";
import { decide, zoneCandidates, type ExistingRecord } from "./policy.ts";
import { DnsWriteError, type DnsWriter, type DnsWriteOutcome } from "./types.ts";

const API = "https://api.digitalocean.com/v2";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 512 * 1024;

/** Record ids go in no path here, but a record type ends up in a sentence the person reads. */
const RECORD_TYPE = /^[A-Z0-9]{1,12}$/;

interface Answer {
  /** 0 when no usable answer came at all. */
  status: number;
  body: Record<string, unknown> | null;
}

async function call(
  doFetch: typeof fetch,
  token: string,
  path: string,
  send?: { body: unknown },
): Promise<Answer> {
  const res = await fetchBounded(
    doFetch,
    `${API}${path}`,
    {
      method: send ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(send ? { "Content-Type": "application/json" } : {}),
      },
      body: send ? JSON.stringify(send.body) : undefined,
    },
    { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BODY_BYTES },
  );
  if (!res) return { status: 0, body: null };
  let json: unknown = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    // Not JSON: the status alone decides.
  }
  return { status: res.status, body: isObject(json) ? json : null };
}

/** Why a call failed, in the person's terms. `reading` is the list call: a token that can't
 *  list can't read the domains, and one that listed but can't create is missing the scope to
 *  change them. */
function refusal(answer: Answer, stage: "reading" | "writing", hostname: string): DnsWriteError {
  if (answer.status === 401) return new DnsWriteError("token_invalid");
  if (answer.status === 403)
    return new DnsWriteError(stage === "reading" ? "zone_read_missing" : "dns_edit_missing");
  // The create is refused as unprocessable when a record at the name keeps it from being added.
  if (answer.status === 422 && stage === "writing")
    return new DnsWriteError("conflict", { hostname });
  return new DnsWriteError("unavailable");
}

function recordsOf(body: Record<string, unknown> | null): ExistingRecord[] {
  const rows = body?.domain_records;
  if (!Array.isArray(rows)) throw new DnsWriteError("unavailable");
  return rows.map((row: unknown) => {
    if (
      !isObject(row) ||
      typeof row.id !== "number" ||
      typeof row.type !== "string" ||
      typeof row.data !== "string" ||
      !RECORD_TYPE.test(row.type)
    )
      throw new DnsWriteError("unavailable");
    return { id: String(row.id), type: row.type, content: row.data };
  });
}

export const digitalocean: DnsWriter = {
  host: "digitalocean",

  /** Add the record to the DigitalOcean domain that holds its name. An identical record is left
   *  as it is. DigitalOcean has no proxy, so the outcome is `created` or `unchanged`. */
  async addRecord({ token, record, fetch: doFetch = fetch }): Promise<DnsWriteOutcome> {
    const hostname = normalizeDnsName(record.name);

    let zone: string | undefined;
    let existing: ExistingRecord[] = [];
    for (const candidate of zoneCandidates(hostname)) {
      // `name` is the whole record name here, and the list is only the records at it.
      const query = new URLSearchParams({ name: hostname, per_page: "200" });
      const answer = await call(
        doFetch,
        token,
        `/domains/${encodeURIComponent(candidate)}/records?${query}`,
      );
      if (answer.status === 200) {
        zone = candidate;
        existing = recordsOf(answer.body);
        break;
      }
      // Not a domain of this account: the name is not the zone, so the next parent is tried.
      if (answer.status !== 404) throw refusal(answer, "reading", hostname);
    }
    if (!zone) throw new DnsWriteError("zone_not_found", { hostname });

    const decision = decide(record, existing, hostname);
    if (decision.kind === "unchanged") return "unchanged";

    // The name DigitalOcean wants is the part before the domain, `@` for the domain itself.
    const name = hostname === zone ? "@" : hostname.slice(0, -(zone.length + 1));
    const created = await call(doFetch, token, `/domains/${encodeURIComponent(zone)}/records`, {
      body: {
        type: record.type,
        name,
        data: record.type === "CNAME" ? `${normalizeDnsName(record.value)}.` : record.value,
        // The API lists these as required for a TXT; they mean nothing for one.
        ...(record.type === "TXT" ? { flags: null, tag: null } : {}),
      },
    });
    if (created.status !== 201) throw refusal(created, "writing", hostname);
    return "created";
  },
};
