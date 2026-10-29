// "Connect with Name.com": add a record to the person's own Name.com domain, with the username
// and API token they paste once. Name.com uses HTTP Basic auth, so the token is
// `username:apitoken`. It lives only in this call's stack: it goes in the Authorization header,
// never in a URL, and never reaches an error. Every refusal is a `DnsWriteError` with a fixed
// message, never Name.com's own words.
//
// The person enables API access first (Account Settings, Security) when 2FA is on.
//
// Spec read 2026-10-29: https://docs.name.com/api/v1/reference/dns/list-records.
// ponytail: not run against a live account. The docs do not say whether a CNAME's `answer` takes
// a trailing dot, so it is sent as given and the record Name.com echoes back must carry the same
// target; if it does not, this fails instead of reporting a record we did not mean to add.
import { fetchBounded, type FetchFn } from "../bounded-fetch.ts";
import { normalizeDnsName } from "../dns-name.ts";
import { isObject } from "../guards.ts";
import { decide, sameValue, zoneCandidates, type ExistingRecord } from "./policy.ts";
import { DnsWriteError, type DnsWriter, type DnsWriteOutcome } from "./types.ts";

const API = "https://api.name.com/core/v1";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 512 * 1024;
/** Name.com's most per page, and how many pages a zone may take before we stop reading. */
const PER_PAGE = 500;
const MAX_PAGES = 10;
/** Name.com's lowest TTL, in seconds. */
const TTL = 300;

const RECORD_TYPE = /^[A-Z0-9]{1,12}$/;

interface Answer {
  /** 0 when no usable answer came at all. */
  status: number;
  body: Record<string, unknown> | null;
}

/** `username:apitoken`, or null when it doesn't look like that. */
function basicOf(token: string): string | null {
  const at = token.indexOf(":");
  return at > 0 && at < token.length - 1 && !/\s/.test(token) ? btoa(token) : null;
}

async function call(
  doFetch: FetchFn,
  basic: string,
  path: string,
  send?: { body: unknown },
): Promise<Answer> {
  const res = await fetchBounded(
    doFetch,
    `${API}${path}`,
    {
      method: send ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${basic}`,
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
 *  list can't read the domains, and one that listed but can't create can't change them. */
function refusal(answer: Answer, stage: "reading" | "writing", hostname: string): DnsWriteError {
  if (answer.status === 401) return new DnsWriteError("token_invalid");
  if (answer.status === 403)
    return new DnsWriteError(stage === "reading" ? "zone_read_missing" : "dns_edit_missing");
  if (answer.status === 409) return new DnsWriteError("conflict", { hostname });
  return new DnsWriteError("unavailable");
}

interface Page {
  records: ExistingRecord[];
  more: boolean;
}

function pageOf(body: Record<string, unknown> | null): Page {
  const rows = body?.records;
  if (!Array.isArray(rows)) throw new DnsWriteError("unavailable");
  const records = rows.map((row: unknown) => {
    if (
      !isObject(row) ||
      typeof row.id !== "number" ||
      typeof row.type !== "string" ||
      typeof row.answer !== "string" ||
      typeof row.fqdn !== "string" ||
      !RECORD_TYPE.test(row.type)
    )
      throw new DnsWriteError("unavailable");
    // `fqdn` is the whole name, ending in a dot.
    return { id: String(row.id), type: row.type, content: row.answer, name: row.fqdn };
  });
  return { records, more: typeof body?.nextPage === "number" };
}

export const namecom: DnsWriter = {
  host: "name-com",

  /** Add the record to the Name.com domain that holds its name. An identical record is left as
   *  it is. Name.com has no proxy, so the outcome is `created` or `unchanged`. */
  async addRecord({ token, record, fetch: doFetch = fetch }): Promise<DnsWriteOutcome> {
    const hostname = normalizeDnsName(record.name);
    const basic = basicOf(token);
    if (!basic) throw new DnsWriteError("token_invalid");

    let zone: string | undefined;
    let existing: ExistingRecord[] = [];
    for (const candidate of zoneCandidates(hostname)) {
      const path = `/domains/${encodeURIComponent(candidate)}/records`;
      const first = await call(doFetch, basic, `${path}?perPage=${PER_PAGE}`);
      if (first.status === 404) continue; // not a domain of this account: try the parent
      if (first.status !== 200) throw refusal(first, "reading", hostname);
      zone = candidate;
      let page = pageOf(first.body);
      existing = page.records;
      for (let next = 2; page.more && next <= MAX_PAGES; next++) {
        const answer = await call(doFetch, basic, `${path}?perPage=${PER_PAGE}&page=${next}`);
        if (answer.status !== 200) throw refusal(answer, "reading", hostname);
        page = pageOf(answer.body);
        existing = existing.concat(page.records);
      }
      // A zone too big to read whole could hide a record that keeps ours from being added.
      if (page.more) throw new DnsWriteError("unavailable");
      break;
    }
    if (!zone) throw new DnsWriteError("zone_not_found", { hostname });

    const here = existing.filter(
      (r) => r.name !== undefined && normalizeDnsName(r.name) === hostname,
    );
    const decision = decide(record, here, hostname);
    if (decision.kind === "unchanged") return "unchanged";

    // The host Name.com wants is the part before the domain, `@` for the domain itself.
    const host = hostname === zone ? "@" : hostname.slice(0, -(zone.length + 1));
    const created = await call(doFetch, basic, `/domains/${encodeURIComponent(zone)}/records`, {
      body: { host, type: record.type, answer: record.value, ttl: TTL },
    });
    if (created.status !== 200) throw refusal(created, "writing", hostname);
    // What Name.com stored must be what we meant. A CNAME it rewrote is not a success.
    const stored = created.body?.answer;
    if (typeof stored !== "string" || !sameValue(record, { content: stored }))
      throw new DnsWriteError("unavailable");
    return "created";
  },
};
