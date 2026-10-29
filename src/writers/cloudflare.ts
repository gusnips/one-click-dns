// "Connect with Cloudflare": add a record to the person's own Cloudflare zone, with an API token
// they paste once. The token lives only in this call's stack. It is never stored, queued,
// audited or logged, never goes in a URL, and never reaches an error: every refusal below is a
// `DnsWriteError` with a fixed message, never Cloudflare's own words.
//
// The origin is fixed, so there is nothing to SSRF-check, but every call is still bounded: no
// redirect followed (a 3xx is not Cloudflare answering), a 10 s deadline that stays armed through
// the body read, and a capped body parsed for the few fields used. We never overwrite or delete a
// record the person already has: a conflict is theirs to resolve.
import { fetchBounded, type BoundedAnswer } from "../bounded-fetch.ts";
import { normalizeDnsName } from "../dns-name.ts";
import { isObject } from "../guards.ts";
import {
  DnsWriteError,
  type DnsWriter,
  type DnsWriteOutcome,
  type DnsWriteRecord,
} from "./types.ts";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;

// Cloudflare's codes for a token it doesn't accept: 1000 invalid token, 6003 invalid request
// headers (with 6111, a malformed Authorization header, in its error_chain), 10000 authentication
// error. An invalid token answers 403 with 10000, so on the zones call these win over the 403
// permission reading. A token missing DNS: Edit answers the records calls with the same 10000.
const TOKEN_CODES = new Set([1000, 6003, 6111, 10000]);
// "A record with that host already exists" (81053 any of A/AAAA/CNAME, 81054 CNAME, 81057 identical).
const CONFLICT_CODES = new Set([81053, 81054, 81057]);

/** Zone and record ids go into a path, so only a plain token of letters and digits passes. */
const ID = /^[A-Za-z0-9]{1,64}$/;
/** A record type ends up in a sentence the person reads ("already has a record (type A)"). */
const RECORD_TYPE = /^[A-Z0-9]{1,12}$/;

interface Envelope {
  success: boolean;
  codes: number[];
  result: unknown;
}

interface Answer {
  status: number;
  body: Envelope | null;
}

type Stage = "zones" | "records";

/** What the call was for, so a refusal can name it. */
interface Subject {
  hostname: string;
  /** The type of the record we tried to add. */
  type: string;
}

/** The envelope's success flag, every error code (and the codes in each `error_chain`), and the
 *  `result`. Null when the body isn't Cloudflare's shape. */
function readEnvelope(json: unknown): Envelope | null {
  if (!isObject(json) || typeof json.success !== "boolean") return null;
  const codes: number[] = [];
  if (Array.isArray(json.errors)) {
    for (const error of json.errors) {
      if (!isObject(error)) return null;
      if (typeof error.code === "number") codes.push(error.code);
      if (Array.isArray(error.error_chain))
        for (const link of error.error_chain)
          if (isObject(link) && typeof link.code === "number") codes.push(link.code);
    }
  }
  return { success: json.success, codes, result: json.result };
}

async function call(
  doFetch: typeof fetch,
  token: string,
  path: string,
  send?: { method: "POST" | "PATCH"; body: unknown },
): Promise<Answer> {
  const res: BoundedAnswer | null = await fetchBounded(
    doFetch,
    `${API}${path}`,
    {
      method: send?.method ?? "GET",
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
    // Not JSON: the status alone decides (a 401 from a proxy still means the token).
  }
  return { status: res.status, body: readEnvelope(json) };
}

/** Why a call failed, in the person's terms. Status 0 is "no usable answer at all". */
function refusal(answer: Answer, stage: Stage, subject: Subject): DnsWriteError {
  const codes = answer.body?.codes ?? [];
  const refusedToken = answer.status === 401 || codes.some((c) => TOKEN_CODES.has(c));
  if (stage === "zones" && refusedToken) return new DnsWriteError("token_invalid");
  // A conflict Cloudflare reports is with the record we tried to add.
  if (codes.some((c) => CONFLICT_CODES.has(c)))
    return new DnsWriteError("conflict", { ...subject });
  if (answer.status === 403 || refusedToken) {
    if (stage === "zones") return new DnsWriteError("zone_read_missing");
    // The records calls run only after this same token listed the zone, so Cloudflare already
    // accepted it: a refusal there is the missing DNS: Edit permission, never a bad token.
    return new DnsWriteError("dns_edit_missing");
  }
  return new DnsWriteError("unavailable");
}

/** The call's `result`, or the refusal it amounts to. */
function resultOf(answer: Answer, stage: Stage, subject: Subject): unknown {
  const ok = answer.status >= 200 && answer.status < 300 && answer.body?.success === true;
  if (!ok) throw refusal(answer, stage, subject);
  return answer.body?.result;
}

interface ZoneRow {
  id: string;
  name: string;
}
interface RecordRow {
  id: string;
  type: string;
  content: string;
  proxied?: boolean;
}

function zonesOf(result: unknown): ZoneRow[] {
  if (!Array.isArray(result)) throw new DnsWriteError("unavailable");
  return result.map((row: unknown) => {
    if (!isObject(row) || typeof row.id !== "string" || typeof row.name !== "string")
      throw new DnsWriteError("unavailable");
    if (!ID.test(row.id)) throw new DnsWriteError("unavailable");
    return { id: row.id, name: row.name };
  });
}

function recordsOf(result: unknown): RecordRow[] {
  if (!Array.isArray(result)) throw new DnsWriteError("unavailable");
  return result.map((row: unknown) => {
    if (
      !isObject(row) ||
      typeof row.id !== "string" ||
      typeof row.type !== "string" ||
      typeof row.content !== "string" ||
      !ID.test(row.id) ||
      !RECORD_TYPE.test(row.type)
    )
      throw new DnsWriteError("unavailable");
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      proxied: typeof row.proxied === "boolean" ? row.proxied : undefined,
    };
  });
}

/** The name and the parents of it, closest first, down to two labels: help.acme.co.uk asks
 *  help.acme.co.uk (a zone of its own, delegated), then acme.co.uk, never co.uk. */
function zoneCandidates(hostname: string): string[] {
  const labels = hostname.split(".");
  const names: string[] = [];
  for (let start = 0; start < labels.length - 1; start++) names.push(labels.slice(start).join("."));
  return names;
}

/** What Cloudflare answers for a TXT: the text wrapped in quotes, split into 255-byte strings
 *  past that. Compared as the text. */
// ponytail: read as the dashboard shows it; confirm against a live zone before relying on it.
const unquoted = (content: string) => content.replace(/"\s+"/g, "").replace(/^"|"$/g, "");

const sameValue = (record: DnsWriteRecord, existing: RecordRow) =>
  record.type === "CNAME"
    ? normalizeDnsName(existing.content) === normalizeDnsName(record.value)
    : unquoted(existing.content) === record.value;

/** A name keeps one SPF record, so a second one at it is a conflict, not an addition. */
const isSpf = (text: string) => /^v=spf1(?:\s|$)/i.test(unquoted(text).trim());

/** Whether `existing` keeps `record` from being added. A CNAME stands alone at its name, and a
 *  TXT can't sit beside one; TXT records beside TXT records are fine, except a second SPF. */
function blocks(record: DnsWriteRecord, existing: RecordRow): boolean {
  if (record.type === "CNAME" || existing.type === "CNAME") return true;
  return existing.type === "TXT" && isSpf(record.value) && isSpf(existing.content);
}

export const cloudflare: DnsWriter = {
  host: "cloudflare",

  /** Add the record (DNS only) to the Cloudflare zone that holds its name. An identical record
   *  is left as it is; the same CNAME behind the proxy gets the proxy turned off. */
  async addRecord({ token, record, comment, fetch: doFetch = fetch }): Promise<DnsWriteOutcome> {
    const hostname = normalizeDnsName(record.name);
    const subject: Subject = { hostname, type: record.type };

    let zoneId: string | undefined;
    for (const candidate of zoneCandidates(hostname)) {
      const query = new URLSearchParams({ name: candidate });
      const zones = zonesOf(
        resultOf(await call(doFetch, token, `/zones?${query}`), "zones", subject),
      );
      zoneId = zones.find((z) => normalizeDnsName(z.name) === candidate)?.id;
      if (zoneId) break;
    }
    if (!zoneId) throw new DnsWriteError("zone_not_found", { hostname });

    const existing = recordsOf(
      resultOf(
        await call(
          doFetch,
          token,
          `/zones/${zoneId}/dns_records?${new URLSearchParams({ name: hostname })}`,
        ),
        "records",
        subject,
      ),
    );
    const ours = existing.find((r) => r.type === record.type && sameValue(record, r));
    if (ours) {
      if (record.type !== "CNAME" || ours.proxied !== true) return "unchanged";
      resultOf(
        await call(doFetch, token, `/zones/${zoneId}/dns_records/${ours.id}`, {
          method: "PATCH",
          body: { proxied: false },
        }),
        "records",
        subject,
      );
      return "unproxied";
    }
    const blocker = existing.find((r) => blocks(record, r));
    if (blocker) throw new DnsWriteError("conflict", { hostname, type: blocker.type });

    resultOf(
      await call(doFetch, token, `/zones/${zoneId}/dns_records`, {
        method: "POST",
        body: {
          type: record.type,
          name: hostname,
          content: record.value,
          // A proxied record hides the CNAME our checker reads.
          ...(record.type === "CNAME" ? { proxied: false } : {}),
          // 1 is Cloudflare's "automatic".
          ttl: 1,
          ...(comment ? { comment } : {}),
        },
      }),
      "records",
      subject,
    );
    return "created";
  },
};
