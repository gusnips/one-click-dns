import { describe, expect, it } from "bun:test";
import { digitalocean } from "./digitalocean.ts";
import type { DnsWriteErrorCode, DnsWriteRecord } from "./types.ts";

// Every call goes to a fake: nothing here reaches DigitalOcean or the network.
const TOKEN = "do-test-token-0123456789-abcdefXYZ";
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** A DigitalOcean refusal. Its message quotes the token, the way a careless upstream might:
 *  nothing we throw may repeat it. */
const refuse = (status: number) => json({ id: "refused", message: `refused ${TOKEN}` }, status);

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

const row = (id: number, name: string, type: string, data: string) => ({
  id,
  name,
  type,
  data,
  ttl: 1800,
  priority: null,
  port: null,
  weight: null,
  flags: null,
  tag: null,
});

/** Only `acme.com` is a domain of the account; `records` are what is at the asked name. */
function domainWith(records: unknown[], domain = "acme.com"): Route {
  return ({ method, url }) => {
    const path = new URL(url).pathname;
    if (method === "GET" && path === `/v2/domains/${domain}/records`)
      return json({ domain_records: records, links: {}, meta: { total: records.length } });
    if (method === "GET") return json({ id: "not_found", message: "not found" }, 404);
    return json({ domain_record: { id: 1 } }, 201);
  };
}

const run = (route: Route, record: DnsWriteRecord = CNAME) => {
  const fake = fakeFetch(route);
  return { ...fake, result: digitalocean.addRecord({ token: TOKEN, record, fetch: fake.fetch }) };
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("digitalocean.addRecord", () => {
  it("only talks to the fixed API origin, with the token in the Bearer header and nowhere else", async () => {
    const { result, calls } = run(domainWith([]));
    expect(await result).toBe("created");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://api.digitalocean.com/v2/")).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN);
      expect(call.redirect).toBe("manual");
    }
  });

  it("asks the closest name first, filters by the whole name, and writes into the domain that answers", async () => {
    const { result, calls } = run(domainWith([]));
    expect(await result).toBe("created");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v2/domains/help.acme.com/records",
      "GET /v2/domains/acme.com/records",
      "POST /v2/domains/acme.com/records",
    ]);
    expect(new URL(calls[1]!.url).searchParams.get("name")).toBe(HOST);
  });

  it("sends the part before the domain as the name, and @ for the domain itself", async () => {
    const sub = run(domainWith([]));
    await sub.result;
    expect(writes(sub.calls)[0]?.body).toMatchObject({ type: "CNAME", name: "help" });

    const apex = run(domainWith([]), { type: "TXT", name: "acme.com", value: "v=DMARC1; p=none" });
    await apex.result;
    expect(writes(apex.calls)[0]?.body).toEqual({
      type: "TXT",
      name: "@",
      data: "v=DMARC1; p=none",
      flags: null,
      tag: null,
    });
  });

  it("ends a CNAME target with a dot, once, or DigitalOcean adds the domain to it", async () => {
    for (const value of [TARGET, `${TARGET}.`, TARGET.toUpperCase()]) {
      const { result, calls } = run(domainWith([]), { ...CNAME, value });
      await result;
      expect(writes(calls)[0]?.body).toMatchObject({ data: `${TARGET}.` });
    }
  });

  it("leaves an identical record alone, case and trailing dot aside", async () => {
    const same = row(11, "help", "CNAME", `${TARGET.toUpperCase()}.`);
    const { result, calls } = run(domainWith([same]));
    expect(await result).toBe("unchanged");
    expect(writes(calls)).toEqual([]);
  });

  it("never overwrites another record at the name: an A record is a conflict that names it", async () => {
    const a = row(12, "help", "A", "203.0.113.9");
    const { result, calls } = run(domainWith([a]));
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
      const other = row(13, "_dmarc", "TXT", "google-site-verification=abc");
      expect(await run(domainWith([other]), TXT).result).toBe("created");
    });

    it("is unchanged when the same text is there", async () => {
      const same = row(14, "_dmarc", "TXT", TXT.value);
      expect(await run(domainWith([same]), TXT).result).toBe("unchanged");
    });

    it("is a conflict when a CNAME holds the name", async () => {
      const cname = row(15, "_dmarc", "CNAME", "elsewhere.example.net.");
      await expect(run(domainWith([cname]), TXT).result).rejects.toMatchObject({
        code: "conflict",
        params: { type: "CNAME" },
      });
    });
  });

  const refusals: [string, Route, DnsWriteErrorCode][] = [
    ["a 401", () => refuse(401), "token_invalid"],
    ["a 403 on the list (no domain:read)", () => refuse(403), "zone_read_missing"],
    ["no domain of the account", () => refuse(404), "zone_not_found"],
    ["a rate limit", () => refuse(429), "unavailable"],
    ["a 5xx", () => refuse(502), "unavailable"],
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
    ["a body that isn't DigitalOcean's", () => new Response("<html>gateway</html>"), "unavailable"],
    ["an oversized body", () => new Response("x".repeat(600 * 1024)), "unavailable"],
    [
      "a 403 on the write (no domain:create)",
      (call) => (call.method === "POST" ? refuse(403) : domainWith([])(call)),
      "dns_edit_missing",
    ],
    [
      "a record that appeared between the read and the write",
      (call) => (call.method === "POST" ? refuse(422) : domainWith([])(call)),
      "conflict",
    ],
  ];

  it.each(refusals)("maps %s to its code, never echoing the token", async (_name, route, code) => {
    const { result } = run(route);
    const error: unknown = await result.catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect(error instanceof Error && error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(String(error instanceof Error ? error.cause : "")).not.toContain(TOKEN);
  });

  it("never lets the name change the path it calls", async () => {
    const fake = fakeFetch(() => refuse(404));
    await digitalocean
      .addRecord({
        token: TOKEN,
        record: { type: "CNAME", name: "a.b/../../account/x?y=1.acme.com", value: TARGET },
        fetch: fake.fetch,
      })
      .catch(() => undefined);
    for (const call of fake.calls) {
      const path = new URL(call.url).pathname;
      expect(path.startsWith("/v2/domains/")).toBe(true);
      expect(path.split("/").length).toBe(5);
    }
  });
});
