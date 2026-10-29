import { describe, expect, it } from "bun:test";
import { porkbun } from "./porkbun.ts";
import type { DnsWriteErrorCode, DnsWriteRecord } from "./types.ts";

// Every call goes to a fake: nothing here reaches Porkbun or the network.
const KEY = "pk1_0123456789abcdef";
const SECRET = "sk1_fedcba9876543210";
const TOKEN = `${KEY}:${SECRET}`;
const HOST = "help.acme.com";
const TARGET = `${"a".repeat(48)}.domains.example.app`;
const CNAME: DnsWriteRecord = { type: "CNAME", name: HOST, value: TARGET };

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  redirect: RequestInit["redirect"];
}
type Route = (call: Call) => Response | Promise<Response>;

const ok = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: "SUCCESS", ...extra }), { status: 200 });
/** A Porkbun refusal. Its message quotes the keys, the way a careless upstream might: nothing we
 *  throw may repeat them. */
const refuse = (code: string, status = 400, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: "ERROR", code, message: `refused ${TOKEN}`, ...extra }), {
    status,
  });

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    return route(call);
  };
  // `typeof fetch` also carries statics (`preconnect`) the module never calls; the function
  // shape is all the fake has to honour.
  return { fetch: impl as unknown as typeof fetch, calls };
}

const row = (id: string, name: string, type: string, content: string) => ({
  id,
  name,
  type,
  content,
  ttl: "600",
  prio: null,
  notes: null,
});

/** Only `acme.com` is a domain of the account; `records` are what its zone holds. */
function zoneWith(records: unknown[], zone = "acme.com"): Route {
  return ({ method, url }) => {
    const path = new URL(url).pathname.replace("/api/json/v3", "");
    if (method === "GET" && path === `/dns/retrieve/${zone}`) return ok({ records });
    if (method === "GET") return refuse("INVALID_DOMAIN");
    return ok({ id: "1001" });
  };
}

const run = (route: Route, record: DnsWriteRecord = CNAME, token = TOKEN) => {
  const fake = fakeFetch(route);
  return { ...fake, result: porkbun.addRecord({ token, record, fetch: fake.fetch }) };
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("porkbun.addRecord", () => {
  it("only talks to the fixed API origin, with the keys in headers and nowhere else", async () => {
    const { result, calls } = run(zoneWith([]));
    expect(await result).toBe("created");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://api.porkbun.com/api/json/v3/")).toBe(true);
      expect(call.url).not.toContain(KEY);
      expect(call.url).not.toContain(SECRET);
      expect(call.headers.get("x-api-key")).toBe(KEY);
      expect(call.headers.get("x-secret-api-key")).toBe(SECRET);
      expect(JSON.stringify(call.body ?? null)).not.toContain(SECRET);
      expect(call.redirect).toBe("manual");
    }
  });

  it("asks the closest name first and writes into the domain that answers", async () => {
    const { result, calls } = run(zoneWith([]));
    expect(await result).toBe("created");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/json/v3/dns/retrieve/help.acme.com",
      "/api/json/v3/dns/retrieve/acme.com",
      "/api/json/v3/dns/create/acme.com",
    ]);
  });

  it("sends the part before the domain as the name, blank for the domain itself", async () => {
    const sub = run(zoneWith([]));
    await sub.result;
    expect(writes(sub.calls)[0]?.body).toEqual({ name: "help", type: "CNAME", content: TARGET });

    const apex = run(zoneWith([]), { type: "TXT", name: "acme.com", value: "v=DMARC1; p=none" });
    await apex.result;
    expect(writes(apex.calls)[0]?.body).toEqual({
      name: "",
      type: "TXT",
      content: "v=DMARC1; p=none",
    });
  });

  it("sends the comment as the record's notes", async () => {
    const fake = fakeFetch(zoneWith([]));
    await porkbun.addRecord({
      token: TOKEN,
      record: CNAME,
      comment: "help center",
      fetch: fake.fetch,
    });
    expect(writes(fake.calls)[0]?.body).toMatchObject({ notes: "help center" });
  });

  it("leaves an identical record alone, case and trailing dot aside", async () => {
    const same = row("11", HOST, "CNAME", `${TARGET.toUpperCase()}.`);
    const { result, calls } = run(zoneWith([same]));
    expect(await result).toBe("unchanged");
    expect(writes(calls)).toEqual([]);
  });

  it("ignores records at other names in the zone", async () => {
    const other = row("12", "www.acme.com", "A", "203.0.113.9");
    const { result, calls } = run(zoneWith([other]));
    expect(await result).toBe("created");
    expect(writes(calls)).toHaveLength(1);
  });

  it("never overwrites another record at the name: an A record is a conflict that names it", async () => {
    const a = row("13", HOST, "A", "203.0.113.9");
    const { result, calls } = run(zoneWith([a]));
    await expect(result).rejects.toMatchObject({
      code: "conflict",
      params: { hostname: HOST, type: "A" },
      message: `${HOST} already has a record (type A)`,
    });
    expect(writes(calls)).toEqual([]);
  });

  describe("a TXT record", () => {
    const TXT: DnsWriteRecord = { type: "TXT", name: "_dmarc.acme.com", value: "v=DMARC1; p=none" };

    it("is added beside other TXT records at the name", async () => {
      const other = row("14", "_dmarc.acme.com", "TXT", "google-site-verification=abc");
      const { result } = run(zoneWith([other]), TXT);
      expect(await result).toBe("created");
    });

    it("is unchanged when the same text is there, quoted or not", async () => {
      const same = row("15", "_dmarc.acme.com", "TXT", `"${TXT.value}"`);
      const { result } = run(zoneWith([same]), TXT);
      expect(await result).toBe("unchanged");
    });

    it("is a conflict when a CNAME holds the name", async () => {
      const cname = row("16", "_dmarc.acme.com", "CNAME", "elsewhere.example.net");
      const { result } = run(zoneWith([cname]), TXT);
      await expect(result).rejects.toMatchObject({ code: "conflict", params: { type: "CNAME" } });
    });
  });

  const refusals: [string, Route, DnsWriteErrorCode][] = [
    ["a wrong key pair", () => refuse("INVALID_API_KEYS_001"), "token_invalid"],
    ["no key", () => refuse("API_KEY_REQUIRED"), "token_invalid"],
    ["API access off for the domain", () => refuse("API_ACCESS_DISABLED"), "dns_edit_missing"],
    ["a key limited by IP", () => refuse("IP_NOT_ALLOWED", 403), "dns_edit_missing"],
    ["a key limited to other domains", () => refuse("DOMAIN_NOT_ALLOWED", 403), "dns_edit_missing"],
    ["no domain of the account", () => refuse("INVALID_DOMAIN"), "zone_not_found"],
    ["a domain not in the account", () => refuse("DOMAIN_NOT_FOUND"), "zone_not_found"],
    ["a rate limit", () => refuse("RATE_LIMIT_EXCEEDED", 429), "unavailable"],
    ["a 5xx", () => new Response("{}", { status: 502 }), "unavailable"],
    [
      "a timeout",
      () => {
        throw new DOMException(`timed out ${TOKEN}`, "TimeoutError");
      },
      "unavailable",
    ],
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }),
      "unavailable",
    ],
    ["a body that isn't Porkbun's", () => new Response("<html>gateway</html>"), "unavailable"],
    ["an oversized body", () => new Response("x".repeat(300 * 1024)), "unavailable"],
    [
      "a record that appeared between the read and the write",
      (call) => (call.method === "POST" ? refuse("RECORD_CONFLICT") : zoneWith([])(call)),
      "conflict",
    ],
    [
      "a write refused for the key",
      (call) => (call.method === "POST" ? refuse("API_ACCESS_DISABLED") : zoneWith([])(call)),
      "dns_edit_missing",
    ],
  ];

  it.each(refusals)("maps %s to its code, never echoing the keys", async (_name, route, code) => {
    const { result } = run(route);
    const error: unknown = await result.catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    for (const secret of [KEY, SECRET, TOKEN]) {
      expect(error instanceof Error && error.message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error instanceof Error ? error.cause : "")).not.toContain(secret);
    }
  });

  it("treats an identical record that appeared between the read and the write as done", async () => {
    const { result } = run((call) =>
      call.method === "POST"
        ? refuse("DUPLICATE_RECORD", 400, { existingId: "9" })
        : zoneWith([])(call),
    );
    expect(await result).toBe("unchanged");
  });

  it("refuses a token that is not a key pair before it calls anything", async () => {
    for (const token of ["", "justonekey", ":secret", "key:", `${KEY} ${SECRET}`]) {
      const { result, calls } = run(zoneWith([]), CNAME, token);
      await expect(result).rejects.toMatchObject({ code: "token_invalid" });
      expect(calls, token).toEqual([]);
    }
  });

  it("follows no redirect", async () => {
    const { result, calls } = run(
      () => new Response(null, { status: 301, headers: { Location: "https://evil.test/" } }),
    );
    await expect(result).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(1);
  });
});

describe("porkbun.addRecord, a name that is not a plain DNS name", () => {
  it("never lets the name change the path it calls", async () => {
    const fake = fakeFetch(() => refuse("INVALID_DOMAIN"));
    await porkbun
      .addRecord({
        token: TOKEN,
        record: { type: "CNAME", name: "a.b/../../account/x?y=1.acme.com", value: TARGET },
        fetch: fake.fetch,
      })
      .catch(() => undefined);
    for (const call of fake.calls) {
      const path = new URL(call.url).pathname;
      expect(path.startsWith("/api/json/v3/dns/retrieve/")).toBe(true);
      expect(path.split("/").length).toBe(7);
      expect(new URL(call.url).search).toBe("");
    }
  });
});
