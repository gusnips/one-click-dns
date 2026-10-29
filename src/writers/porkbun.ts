// "Connect with Porkbun": add a record to the person's own Porkbun domain, with an API key pair
// they paste once. Porkbun gives two secrets, so the token is `apikey:secretapikey` (the two
// keys start with `pk1_` and `sk1_`; neither holds a colon). The keys live only in this call's
// stack. They go in headers, never in a URL, and never reach an error: every refusal is a
// `DnsWriteError` with a fixed message, never Porkbun's own words.
//
// The person turns on "API access" for each domain in Porkbun first (it is off by default), or
// for all of them in account settings. A write to a domain that is not pointed at Porkbun's name
// servers is accepted and changes nothing that resolves, so the app's own DNS check, not this
// write, is what says the record is live.
//
// Spec read 2026-10-29: https://porkbun.com/api/json/v3/spec.
import { fetchBounded } from "../bounded-fetch.ts";
import { normalizeDnsName } from "../dns-name.ts";
import { isObject } from "../guards.ts";
import { decide, zoneCandidates, type ExistingRecord } from "./policy.ts";
import { DnsWriteError, type DnsWriter, type DnsWriteOutcome } from "./types.ts";

const API = "https://api.porkbun.com/api/json/v3";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

/** The key was not accepted. */
const KEY_CODES = new Set([
  "API_KEY_REQUIRED",
  "INVALID_API_KEYS_001",
  "INVALID_TOKEN",
  "INVALID_USER",
]);
/** The key is good, but it may not touch this domain: API access is off for it, or the key is
 *  limited by IP or by domain. */
const ACCESS_CODES = new Set(["API_ACCESS_DISABLED", "IP_NOT_ALLOWED", "DOMAIN_NOT_ALLOWED"]);
/** Not a domain of this account: the name is not the zone, so the next parent is tried. */
const NOT_A_ZONE_CODES = new Set(["INVALID_DOMAIN", "DOMAIN_NOT_FOUND"]);

/** Record ids go in a path, so only digits pass. */
const ID = /^[0-9]{1,20}$/;
const RECORD_TYPE = /^[A-Z0-9]{1,12}$/;

interface Answer {
  /** Porkbun's `code` when it refused; "" when it did not say. */
  code: string;
  ok: boolean;
  body: Record<string, unknown> | null;
}

interface Keys {
  key: string;
  secret: string;
}

/** `apikey:secretapikey`, or null when it doesn't look like that. */
function keysOf(token: string): Keys | null {
  const at = token.indexOf(":");
  const key = token.slice(0, at);
  const secret = token.slice(at + 1);
  return at > 0 && secret && !/\s/.test(token) ? { key, secret } : null;
}

async function call(
  doFetch: typeof fetch,
  keys: Keys,
  path: string,
  send?: { body: unknown },
): Promise<Answer> {
  const res = await fetchBounded(
    doFetch,
    `${API}${path}`,
    {
      method: send ? "POST" : "GET",
      headers: {
        "X-API-Key": keys.key,
        "X-Secret-API-Key": keys.secret,
        Accept: "application/json",
        ...(send ? { "Content-Type": "application/json" } : {}),
      },
      body: send ? JSON.stringify(send.body) : undefined,
    },
    { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BODY_BYTES },
  );
  if (!res) return { code: "", ok: false, body: null };
  let json: unknown = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    // Not JSON: the status alone decides.
  }
  const body = isObject(json) ? json : null;
  return {
    code: typeof body?.code === "string" ? body.code : "",
    ok: res.status === 200 && body?.status === "SUCCESS",
    body,
  };
}

/** Why a call failed, in the person's terms. */
function refusal(answer: Answer, hostname: string): DnsWriteError {
  if (KEY_CODES.has(answer.code)) return new DnsWriteError("token_invalid");
  if (ACCESS_CODES.has(answer.code)) return new DnsWriteError("dns_edit_missing");
  if (answer.code === "RECORD_CONFLICT") return new DnsWriteError("conflict", { hostname });
  return new DnsWriteError("unavailable");
}

function recordsOf(body: Record<string, unknown> | null): ExistingRecord[] {
  const rows = body?.records;
  if (!Array.isArray(rows)) throw new DnsWriteError("unavailable");
  return rows.map((row: unknown) => {
    if (
      !isObject(row) ||
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.type !== "string" ||
      typeof row.content !== "string" ||
      !ID.test(row.id) ||
      !RECORD_TYPE.test(row.type)
    )
      throw new DnsWriteError("unavailable");
    // Porkbun lists the whole zone; the caller keeps the records at our name.
    return { id: row.id, type: row.type, content: row.content, name: row.name };
  });
}

export const porkbun: DnsWriter = {
  host: "porkbun",

  /** Add the record to the Porkbun domain that holds its name. An identical record is left as
   *  it is. Porkbun has no proxy, so the outcome is `created` or `unchanged`. */
  async addRecord({ token, record, comment, fetch: doFetch = fetch }): Promise<DnsWriteOutcome> {
    const hostname = normalizeDnsName(record.name);
    const keys = keysOf(token);
    if (!keys) throw new DnsWriteError("token_invalid");

    let zone: string | undefined;
    let existing: ExistingRecord[] = [];
    for (const candidate of zoneCandidates(hostname)) {
      const answer = await call(doFetch, keys, `/dns/retrieve/${encodeURIComponent(candidate)}`);
      if (answer.ok) {
        zone = candidate;
        existing = recordsOf(answer.body).filter(
          (r) => r.name !== undefined && normalizeDnsName(r.name) === hostname,
        );
        break;
      }
      if (!NOT_A_ZONE_CODES.has(answer.code)) throw refusal(answer, hostname);
    }
    if (!zone) throw new DnsWriteError("zone_not_found", { hostname });

    const decision = decide(record, existing, hostname);
    if (decision.kind === "unchanged") return "unchanged";

    // The name Porkbun wants is the part before the domain, blank for the domain itself.
    const subdomain = hostname === zone ? "" : hostname.slice(0, -(zone.length + 1));
    const created = await call(doFetch, keys, `/dns/create/${encodeURIComponent(zone)}`, {
      body: {
        name: subdomain,
        type: record.type,
        content: record.value,
        ...(comment ? { notes: comment } : {}),
      },
    });
    // The same record appeared between the read and the write: it is there, which is the goal.
    if (created.code === "DUPLICATE_RECORD") return "unchanged";
    if (!created.ok) throw refusal(created, hostname);
    return "created";
  },
};
