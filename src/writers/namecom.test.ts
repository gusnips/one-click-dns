import { describe, expect, it } from "bun:test";
import { namecom } from "./namecom.ts";
import type { DnsWriteErrorCode, DnsWriteRecord } from "./types.ts";

// Every call goes to a fake: nothing here reaches Name.com or the network.
const USER = "janedoe";
const API_TOKEN = "nc-test-token-0123456789abcdef";
const TOKEN = `${USER}:${API_TOKEN}`;
const BASIC = btoa(TOKEN);
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
/** A Name.com refusal. Its message quotes the credentials, the way a careless upstream might:
 *  nothing we throw may repeat them. */
const refuse = (status: number) => json({ message: `refused ${TOKEN}` }, status);

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
  return { fetch: impl, calls };
}

const row = (id: number, host: string, type: string, answer: string, zone = "acme.com") => ({
  id,
  domainName: zone,
  host,
  fqdn: `${host ? `${host}.` : ""}${zone}.`,
  type,
  answer,
  ttl: 300,
});

/** Only `acme.com` is a domain of the account; `records` are what its zone holds. The create call
 *  echoes the record back the way Name.com does, unless `echo` says otherwise. */
function zoneWith(
  records: unknown[],
  options: { zone?: string; echo?: (sent: Record<string, unknown>) => unknown } = {},
): Route {
  const { zone = "acme.com", echo = (sent) => ({ id: 99, ...sent }) } = options;
  return ({ method, url, body }) => {
    const path = new URL(url).pathname;
    if (method === "GET" && path === `/core/v1/domains/${zone}/records`)
      return json({ records, totalCount: records.length, from: 1, to: records.length });
    if (method === "GET") return json({ message: "Not Found" }, 404);
    return json(echo(body as Record<string, unknown>));
  };
}

const run = (route: Route, record: DnsWriteRecord = CNAME, token = TOKEN) => {
  const fake = fakeFetch(route);
  return { ...fake, result: namecom.addRecord({ token, record, fetch: fake.fetch }) };
};

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("namecom.addRecord", () => {
  it("only talks to the fixed API origin, with the credentials in the Basic header and nowhere else", async () => {
    const { result, calls } = run(zoneWith([]));
    expect(await result).toBe("created");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith("https://api.name.com/core/v1/")).toBe(true);
      expect(call.url).not.toContain(API_TOKEN);
      expect(call.headers.get("authorization")).toBe(`Basic ${BASIC}`);
      expect(JSON.stringify(call.body ?? null)).not.toContain(API_TOKEN);
      expect(call.redirect).toBe("manual");
    }
  });

  it("asks the closest name first and writes into the domain that answers", async () => {
    const { result, calls } = run(zoneWith([]));
    expect(await result).toBe("created");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /core/v1/domains/help.acme.com/records",
      "GET /core/v1/domains/acme.com/records",
      "POST /core/v1/domains/acme.com/records",
    ]);
  });

  it("sends the part before the domain as the host, @ for the domain itself, and the lowest TTL", async () => {
    const sub = run(zoneWith([]));
    await sub.result;
    expect(writes(sub.calls)[0]?.body).toEqual({
      host: "help",
      type: "CNAME",
      answer: TARGET,
      ttl: 300,
    });

    const apex = run(zoneWith([]), { type: "TXT", name: "acme.com", value: "v=DMARC1; p=none" });
    await apex.result;
    expect(writes(apex.calls)[0]?.body).toMatchObject({ host: "@", type: "TXT" });
  });

  it("leaves an identical record alone, case and trailing dot aside", async () => {
    const same = row(11, "help", "CNAME", `${TARGET.toUpperCase()}.`);
    const { result, calls } = run(zoneWith([same]));
    expect(await result).toBe("unchanged");
    expect(writes(calls)).toEqual([]);
  });

  it("ignores records at other names in the zone", async () => {
    const other = row(12, "www", "A", "203.0.113.9");
    const { result, calls } = run(zoneWith([other]));
    expect(await result).toBe("created");
    expect(writes(calls)).toHaveLength(1);
  });

  it("never overwrites another record at the name: an A record is a conflict that names it", async () => {
    const a = row(13, "help", "A", "203.0.113.9");
    const { result, calls } = run(zoneWith([a]));
    await expect(result).rejects.toMatchObject({
      code: "conflict",
      params: { hostname: HOST, type: "A" },
    });
    expect(writes(calls)).toEqual([]);
  });

  it("reads every page of a big zone before it decides", async () => {
    const pages = new Map([
      [
        1,
        {
          records: [row(1, "www", "A", "203.0.113.1")],
          nextPage: 2,
          totalCount: 2,
          from: 1,
          to: 1,
        },
      ],
      [2, { records: [row(2, "help", "A", "203.0.113.2")], totalCount: 2, from: 2, to: 2 }],
    ]);
    const route: Route = ({ method, url }) => {
      const u = new URL(url);
      if (method === "GET" && u.pathname.endsWith("/acme.com/records"))
        return json(pages.get(Number(u.searchParams.get("page") ?? 1)));
      return method === "GET" ? json({ message: "Not Found" }, 404) : json({});
    };
    const { result, calls } = run(route);
    await expect(result).rejects.toMatchObject({ code: "conflict", params: { type: "A" } });
    expect(writes(calls)).toEqual([]);
  });

  it("gives up on a zone it cannot read whole, rather than guess", async () => {
    const endless: Route = ({ method, url }) =>
      method === "GET" && new URL(url).pathname.endsWith("/acme.com/records")
        ? json({ records: [], nextPage: 2, totalCount: 9999, from: 1, to: 0 })
        : json({ message: "Not Found" }, 404);
    const { result, calls } = run(endless);
    await expect(result).rejects.toMatchObject({ code: "unavailable" });
    expect(writes(calls)).toEqual([]);
  });

  describe("a TXT record", () => {
    const TXT: DnsWriteRecord = { type: "TXT", name: "_dmarc.acme.com", value: "v=DMARC1; p=none" };

    it("is added beside other TXT records at the name", async () => {
      const other = row(14, "_dmarc", "TXT", "google-site-verification=abc");
      expect(await run(zoneWith([other]), TXT).result).toBe("created");
    });

    it("is unchanged when the same text is there, quoted or not", async () => {
      const same = row(15, "_dmarc", "TXT", `"${TXT.value}"`);
      expect(await run(zoneWith([same]), TXT).result).toBe("unchanged");
    });

    it("is a conflict when a CNAME holds the name", async () => {
      const cname = row(16, "_dmarc", "CNAME", "elsewhere.example.net.");
      await expect(run(zoneWith([cname]), TXT).result).rejects.toMatchObject({
        code: "conflict",
        params: { type: "CNAME" },
      });
    });
  });

  it("fails, and does not report success, when Name.com stored a different target", async () => {
    const rewritten = zoneWith([], {
      echo: (sent) => ({ id: 99, ...sent, answer: `${TARGET}.acme.com` }),
    });
    await expect(run(rewritten).result).rejects.toMatchObject({ code: "unavailable" });
  });

  it("accepts the target echoed back with a final dot", async () => {
    const dotted = zoneWith([], { echo: (sent) => ({ id: 99, ...sent, answer: `${TARGET}.` }) });
    expect(await run(dotted).result).toBe("created");
  });

  const refusals: [string, Route, DnsWriteErrorCode][] = [
    ["a 401", () => refuse(401), "token_invalid"],
    ["a 403 on the list", () => refuse(403), "zone_read_missing"],
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
    ["a body that isn't Name.com's", () => new Response("<html>gateway</html>"), "unavailable"],
    ["an oversized body", () => new Response("x".repeat(600 * 1024)), "unavailable"],
    [
      "a 403 on the write",
      (call) => (call.method === "POST" ? refuse(403) : zoneWith([])(call)),
      "dns_edit_missing",
    ],
    [
      "a 409 on the write",
      (call) => (call.method === "POST" ? refuse(409) : zoneWith([])(call)),
      "conflict",
    ],
  ];

  it.each(refusals)(
    "maps %s to its code, never echoing the credentials",
    async (_name, route, code) => {
      const { result } = run(route);
      const error: unknown = await result.catch((e: unknown) => e);
      expect(error).toMatchObject({ code });
      for (const secret of [API_TOKEN, TOKEN, BASIC]) {
        expect(error instanceof Error && error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(String(error instanceof Error ? error.cause : "")).not.toContain(secret);
      }
    },
  );

  it("refuses a token that is not username:token before it calls anything", async () => {
    for (const token of ["", "justone", ":token", "user:", `user: ${API_TOKEN}`]) {
      const { result, calls } = run(zoneWith([]), CNAME, token);
      await expect(result).rejects.toMatchObject({ code: "token_invalid" });
      expect(calls, token).toEqual([]);
    }
  });

  it("never lets the name change the path it calls", async () => {
    const fake = fakeFetch(() => refuse(404));
    await namecom
      .addRecord({
        token: TOKEN,
        record: { type: "CNAME", name: "a.b/../../account/x?y=1.acme.com", value: TARGET },
        fetch: fake.fetch,
      })
      .catch(() => undefined);
    for (const call of fake.calls) {
      const path = new URL(call.url).pathname;
      expect(path.startsWith("/core/v1/domains/")).toBe(true);
      expect(path.split("/").length).toBe(6);
    }
  });
});
