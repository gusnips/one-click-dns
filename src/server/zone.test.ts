// The walk up a name's tree to the zone that has name servers. Scripted answers
// only: no test asks DNS.
import { describe, expect, it } from "bun:test";
import type { DnsAnswer } from "./dns.ts";
import { dnsHostOf, readDnsZone, type ZoneLookups } from "./zone.ts";

type NsAnswer = DnsAnswer<{ names: string[] }>;
type CnameAnswer = DnsAnswer<{ name: string }>;

const CLOUDFLARE = ["bob.ns.cloudflare.com", "ada.ns.cloudflare.com"];

/** Name servers by name (any other name is "nothing there"), CNAMEs by name, and names whose
 *  questions never answer. Every question asked is kept, in order. */
function dns(tables: {
  ns?: Record<string, string[]>;
  cnames?: Record<string, string>;
  failNs?: string[];
  failCname?: string[];
}): ZoneLookups & { asked: string[] } {
  const { ns = {}, cnames = {}, failNs = [], failCname = [] } = tables;
  const asked: string[] = [];
  return {
    asked,
    async ns(name): Promise<NsAnswer> {
      asked.push(`ns ${name}`);
      if (failNs.includes(name)) return "failed";
      const names = ns[name];
      return names ? { names } : "absent";
    },
    async cname(name): Promise<CnameAnswer> {
      asked.push(`cname ${name}`);
      if (failCname.includes(name)) return "failed";
      const target = cnames[name];
      return target ? { name: target } : "absent";
    },
  };
}

const read = (lookups: ZoneLookups, hostname: string, budgetMs = 1_000) =>
  readDnsZone(lookups, hostname, budgetMs);

describe("readDnsZone", () => {
  it("walks up from the hostname to the zone that answers, and sorts its names", async () => {
    const lookups = dns({ ns: { "acme.com": CLOUDFLARE } });
    expect(await read(lookups, "t.acme.com")).toEqual({
      zone: "acme.com",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    expect(lookups.asked).toEqual(["ns t.acme.com", "ns acme.com", "cname acme.com"]);
  });

  it("stops at the first name that answers: a delegated subdomain is its own zone", async () => {
    const lookups = dns({
      ns: { "t.acme.com": ["ns1.digitalocean.com"], "acme.com": CLOUDFLARE },
    });
    expect((await read(lookups, "t.acme.com"))?.zone).toBe("t.acme.com");
  });

  it("reads a name under a two-label suffix without asking the suffix", async () => {
    const lookups = dns({ ns: { "acme.com.br": ["a.auto.dns.br", "b.auto.dns.br"] } });
    expect((await read(lookups, "t.acme.com.br"))?.zone).toBe("acme.com.br");
    const none = dns({});
    expect(await read(none, "t.acme.com.br")).toBeNull();
    expect(none.asked).toEqual(["ns t.acme.com.br", "ns acme.com.br", "ns com.br"]);
  });

  it("never asks a one-label top level", async () => {
    const lookups = dns({});
    expect(await read(lookups, "t.acme.com")).toBeNull();
    expect(lookups.asked).toEqual(["ns t.acme.com", "ns acme.com"]);
  });

  it("spells the answer the way the table reads it: lowercase, no trailing dot, once each", async () => {
    const lookups = dns({
      ns: { "acme.com": ["ADA.ns.cloudflare.com.", "ada.ns.cloudflare.com"] },
    });
    expect((await read(lookups, "T.Acme.com.")) ?? null).toEqual({
      zone: "acme.com",
      nameservers: ["ada.ns.cloudflare.com"],
    });
  });

  it("skips a name that holds a CNAME: its NS answer would be the target's", async () => {
    const lookups = dns({
      ns: { "t.acme.com": ["ns1.vercel-dns.com"], "acme.com": CLOUDFLARE },
      cnames: { "t.acme.com": "cname.vercel-dns.com" },
    });
    expect((await read(lookups, "t.acme.com"))?.zone).toBe("acme.com");
  });

  it("is null, not empty, when DNS did not answer", async () => {
    expect(await read(dns({ failNs: ["t.acme.com"] }), "t.acme.com")).toBeNull();
    expect(await read(dns({ failNs: ["acme.com"] }), "t.acme.com")).toBeNull();
    const noGuard = dns({ ns: { "acme.com": CLOUDFLARE }, failCname: ["acme.com"] });
    expect(await read(noGuard, "t.acme.com")).toBeNull();
  });

  it("gives up after its budget, however long a question takes", async () => {
    const slow: ZoneLookups = {
      ns: () => new Promise<NsAnswer>(() => undefined),
      cname: async () => "absent",
    };
    const started = Date.now();
    expect(await read(slow, "t.acme.com", 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("dnsHostOf", () => {
  it("names the host the zone's name servers mean", () => {
    expect(dnsHostOf({ zone: "acme.com", nameservers: ["ada.ns.cloudflare.com"] })).toEqual({
      zone: "acme.com",
      nameservers: ["ada.ns.cloudflare.com"],
      hosts: ["cloudflare"],
    });
  });

  it("keeps names nobody claims, with no host", () => {
    expect(dnsHostOf({ zone: "acme.com", nameservers: ["ns1.acme.net"] }).hosts).toEqual([]);
  });
});
