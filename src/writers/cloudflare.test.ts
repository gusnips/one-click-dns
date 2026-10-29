import { describe, expect, it } from "bun:test";
import { cloudflare } from "./cloudflare.ts";
import type { DnsWriteErrorCode, DnsWriteRecord } from "./types.ts";

// Every call goes to a fake: nothing here reaches Cloudflare or the network.
const TOKEN = "cfTestToken_0123456789-abcdefXYZ";
const ZONE = "023e105f4ecef8ad9ca31a8372d0c353";
const RECORD = "372e67954025e0ba6aaa6d586b9e0b59";
const HOST = "help.acme.com";
const TARGET = `${"a".repeat(48)}.domains.example.app`;
const CNAME: DnsWriteRecord = { type: "CNAME", name: HOST, value: TARGET };

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null | undefined;
}
type Route = (call: Call) => Response | Promise<Response>;

/** A Cloudflare success envelope. */
const answer = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status });
/** A Cloudflare failure envelope. Its message quotes the token, the way a careless upstream
 *  might: nothing we throw may repeat it. */
const failure = (status: number, codes: number[] = []) =>
  new Response(
    JSON.stringify({
      success: false,
      errors: codes.map((code) => ({ code, message: `rejected ${TOKEN}` })),
      result: null,
    }),
    { status },
  );

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
      signal: init?.signal,
    };
    calls.push(call);
    return route(call);
  };
  return { fetch: impl, calls };
}

/** A zone `acme.com` and the given records at the hostname; writes answer with an empty record. */
function zoneWith(records: unknown[], zoneName = "acme.com"): Route {
  return ({ method, url }) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/zones"))
      return answer(u.searchParams.get("name") === zoneName ? [{ id: ZONE, name: zoneName }] : []);
    if (method === "GET") return answer(records);
    return answer({ id: RECORD });
  };
}

const run = (route: Route, record: DnsWriteRecord = CNAME, comment?: string) => {
  const fake = fakeFetch(route);
  return {
    ...fake,
    result: cloudflare.addRecord({ token: TOKEN, record, comment, fetch: fake.fetch }),
  };
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const zonesAsked = (calls: Call[]) =>
  calls
    .filter((c) => new URL(c.url).pathname.endsWith("/zones"))
    .map((c) => new URL(c.url).searchParams.get("name"));

describe("cloudflare.addRecord", () => {
  it("only talks to the fixed API origin, with the token in the Bearer header and nowhere else", async () => {
    const { result, calls } = run(zoneWith([]));
    expect(await result).toBe("created");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN);
      expect(call.redirect).toBe("manual");
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("asks the closest name first, so acme.co.uk is tried before co.uk", async () => {
    const { result, calls } = run(zoneWith([], "acme.co.uk"), {
      ...CNAME,
      name: "help.acme.co.uk",
    });
    expect(await result).toBe("created");
    expect(zonesAsked(calls)).toEqual(["help.acme.co.uk", "acme.co.uk"]);
  });

  it("writes into the name's own zone when the name is a zone of its own", async () => {
    const { result, calls } = run(zoneWith([], "help.acme.com"));
    expect(await result).toBe("created");
    expect(zonesAsked(calls)).toEqual(["help.acme.com"]);
  });

  it("walks down to two labels when the closer names are not zones", async () => {
    const { result, calls } = run(zoneWith([], "acme.co.uk"), {
      ...CNAME,
      name: "docs.help.acme.co.uk",
    });
    expect(await result).toBe("created");
    expect(zonesAsked(calls)).toEqual(["docs.help.acme.co.uk", "help.acme.co.uk", "acme.co.uk"]);
  });

  it("leaves an identical DNS-only record alone, case and trailing dot aside", async () => {
    const record = {
      id: RECORD,
      type: "CNAME",
      content: `${TARGET.toUpperCase()}.`,
      proxied: false,
    };
    const { result, calls } = run(zoneWith([record]));
    expect(await result).toBe("unchanged");
    expect(writes(calls)).toEqual([]);
  });

  it("turns the proxy off on an identical proxied record, and changes nothing else", async () => {
    const record = { id: RECORD, type: "CNAME", content: TARGET, proxied: true };
    const { result, calls } = run(zoneWith([record]));
    expect(await result).toBe("unproxied");
    const [patch, ...rest] = writes(calls);
    expect(rest).toEqual([]);
    expect(patch?.method).toBe("PATCH");
    expect(new URL(patch!.url).pathname).toBe(`/client/v4/zones/${ZONE}/dns_records/${RECORD}`);
    expect(patch?.body).toEqual({ proxied: false });
  });

  it("never overwrites another record at the name: an A record is a conflict that names it", async () => {
    const record = { id: RECORD, type: "A", content: "203.0.113.9", proxied: false };
    const { result, calls } = run(zoneWith([record]));
    await expect(result).rejects.toMatchObject({
      code: "conflict",
      params: { hostname: HOST, type: "A" },
      message: `${HOST} already has a record (type A)`,
    });
    expect(writes(calls)).toEqual([]);
  });

  it("creates a DNS-only CNAME when the name is free, with the comment when given", async () => {
    const { result, calls } = run(zoneWith([]), CNAME, "help center");
    expect(await result).toBe("created");
    const [post, ...rest] = writes(calls);
    expect(rest).toEqual([]);
    expect(post?.method).toBe("POST");
    expect(new URL(post!.url).pathname).toBe(`/client/v4/zones/${ZONE}/dns_records`);
    expect(post?.body).toMatchObject({
      type: "CNAME",
      name: HOST,
      content: TARGET,
      proxied: false,
      comment: "help center",
    });
  });

  describe("a TXT record", () => {
    const TXT: DnsWriteRecord = { type: "TXT", name: "_dmarc.acme.com", value: "v=DMARC1; p=none" };

    it("is added beside other TXT records at the name, with no proxy field", async () => {
      const other = { id: RECORD, type: "TXT", content: '"google-site-verification=abc"' };
      const { result, calls } = run(zoneWith([other]), TXT);
      expect(await result).toBe("created");
      const [post] = writes(calls);
      expect(post?.body).toMatchObject({
        type: "TXT",
        name: "_dmarc.acme.com",
        content: TXT.value,
      });
      expect(post?.body).not.toHaveProperty("proxied");
    });

    it("is unchanged when the same text is there, quoted the way Cloudflare shows it", async () => {
      const same = { id: RECORD, type: "TXT", content: `"${TXT.value}"` };
      const { result, calls } = run(zoneWith([same]), TXT);
      expect(await result).toBe("unchanged");
      expect(writes(calls)).toEqual([]);
    });

    it("is a conflict when a CNAME holds the name", async () => {
      const cname = { id: RECORD, type: "CNAME", content: "elsewhere.example.net" };
      const { result } = run(zoneWith([cname]), TXT);
      await expect(result).rejects.toMatchObject({ code: "conflict", params: { type: "CNAME" } });
    });

    it("is a conflict for a second SPF record: a name keeps one", async () => {
      const spf: DnsWriteRecord = {
        type: "TXT",
        name: "acme.com",
        value: "v=spf1 include:a.example ~all",
      };
      const old = { id: RECORD, type: "TXT", content: '"v=spf1 include:b.example -all"' };
      const { result, calls } = run(zoneWith([old]), spf);
      await expect(result).rejects.toMatchObject({ code: "conflict", params: { type: "TXT" } });
      expect(writes(calls)).toEqual([]);
    });
  });

  const CASES: [string, Route, DnsWriteErrorCode][] = [
    ["a 401", () => failure(401, [10000]), "token_invalid"],
    [
      "a 403 on zones that says the token itself is bad",
      () => failure(403, [10000]),
      "token_invalid",
    ],
    [
      "a malformed Authorization header",
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 6003, error_chain: [{ code: 6111 }] }],
            result: null,
          }),
          { status: 400 },
        ),
      "token_invalid",
    ],
    [
      "a failure with no result field",
      () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), {
          status: 403,
        }),
      "token_invalid",
    ],
    ["a 403 on zones", () => failure(403, [9109]), "zone_read_missing"],
    // Measured against a real account on 2026-10-29: both answer 403 with code 9109.
    [
      "a wrong token (403, 9109, 'Invalid access token')",
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 9109, message: "Invalid access token" }],
            result: null,
          }),
          { status: 403 },
        ),
      "token_invalid",
    ],
    [
      "a good token without the permission (403, 9109, 'Unauthorized to access requested resource')",
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
            result: null,
          }),
          { status: 403 },
        ),
      "zone_read_missing",
    ],
    ["no zone", () => answer([]), "zone_not_found"],
    [
      "a 403 on the records read",
      ({ url }) =>
        new URL(url).pathname.endsWith("/zones")
          ? answer([{ id: ZONE, name: "acme.com" }])
          : failure(403, [9109]),
      "dns_edit_missing",
    ],
    [
      "a 403 on the write",
      (call) => (call.method === "POST" ? failure(403, [9109]) : zoneWith([])(call)),
      "dns_edit_missing",
    ],
    // The zone answered, so the token is good: Cloudflare's 10000 here is the missing
    // DNS: Edit, and "paste it again" would send the person round in circles.
    [
      "a 403 with the token code on the records read, after the zone answered",
      ({ url }) =>
        new URL(url).pathname.endsWith("/zones")
          ? answer([{ id: ZONE, name: "acme.com" }])
          : failure(403, [10000]),
      "dns_edit_missing",
    ],
    [
      "a 403 with the token code on the write",
      (call) => (call.method === "POST" ? failure(403, [10000]) : zoneWith([])(call)),
      "dns_edit_missing",
    ],
    [
      "a 401 on the records read, after the zone answered",
      ({ url }) =>
        new URL(url).pathname.endsWith("/zones")
          ? answer([{ id: ZONE, name: "acme.com" }])
          : failure(401),
      "dns_edit_missing",
    ],
    [
      "a record that appeared between the read and the write",
      (call) => (call.method === "POST" ? failure(400, [81053]) : zoneWith([])(call)),
      "conflict",
    ],
    ["a 5xx", () => failure(502), "unavailable"],
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
    [
      "a body that isn't Cloudflare's",
      () => new Response("<html>gateway</html>", { status: 200 }),
      "unavailable",
    ],
    [
      "an oversized body",
      () => new Response("x".repeat(300 * 1024), { status: 200 }),
      "unavailable",
    ],
  ];

  it.each(CASES)("maps %s to its code, never echoing the token", async (_name, route, code) => {
    const { result } = run(route);
    const error: unknown = await result.catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect(error instanceof Error && error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String(error instanceof Error ? error.cause : "")).not.toContain(TOKEN);
  });

  it("follows no redirect", async () => {
    const { result, calls } = run(
      () => new Response(null, { status: 301, headers: { Location: "https://evil.test/" } }),
    );
    await expect(result).rejects.toMatchObject({ code: "unavailable" });
    expect(calls).toHaveLength(1);
  });
});
