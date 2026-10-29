// The nameserver table and the host data. Every name below is shaped like what
// the research records for that host; no test asks DNS.
import { describe, expect, it } from "bun:test";
import { normalizeDnsName } from "./dns-name.ts";
import {
  DNS_HOSTS,
  DNS_HOST_IDS,
  detectDnsHosts,
  trapOf,
  type DnsHostId,
  type DnsTrapKind,
} from "./hosts.ts";

/** One zone's name servers and the hosts they must read as. */
const ZONES: readonly [names: string[], hosts: DnsHostId[]][] = [
  [["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"], ["cloudflare"]],
  [
    ["green.foundationdns.com", "green.foundationdns.net", "green.foundationdns.org"],
    ["cloudflare"],
  ],
  [["ns45.domaincontrol.com", "ns46.domaincontrol.com"], ["godaddy"]],
  [["dns1.registrar-servers.com", "dns2.registrar-servers.com"], ["namecheap"]],
  [["pdns1.registrar-servers.com", "pdns2.registrar-servers.com"], ["namecheap"]],
  [["freedns1.registrar-servers.com", "freedns5.registrar-servers.com"], ["namecheap"]],
  [["dns1.namecheaphosting.com", "dns2.namecheaphosting.com"], ["namecheap-hosting"]],
  [["ns1.squarespacedns.com", "ns2.squarespacedns.com"], ["squarespace"]],
  [
    [
      "ns-2048.awsdns-64.com",
      "ns-2049.awsdns-65.net",
      "ns-2050.awsdns-66.org",
      "ns-2051.awsdns-67.co.uk",
    ],
    ["route53"],
  ],
  [
    ["ns-cloud-a1.googledomains.com", "ns-cloud-a2.googledomains.com"],
    ["squarespace", "google-cloud-dns"],
  ],
  [
    [
      "ns1-37.azure-dns.com",
      "ns2-37.azure-dns.net",
      "ns3-37.azure-dns.org",
      "ns4-37.azure-dns.info",
    ],
    ["azure-dns"],
  ],
  [["ns1016.ui-dns.de", "ns1016.ui-dns.biz", "ns1016.ui-dns.org", "ns1016.ui-dns.com"], ["ionos"]],
  [["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"], ["porkbun"]],
  [["ns1fwz.name.com", "ns2fwz.name.com", "ns3fwz.name.com"], ["name-com"]],
  [["ns1.dyna-ns.net", "ns2.dyna-ns.net"], ["dynadot"]],
  [["ns1.dnsowl.com", "ns2.dnsowl.com", "ns3.dnsowl.com"], ["namesilo"]],
  [["ns-110-a.gandi.net", "ns-107-b.gandi.net", "ns-161-c.gandi.net"], ["gandi"]],
  [["ns12.ovh.net", "dns12.ovh.net"], ["ovhcloud"]],
  [["ns123.ovh.net", "dns123.ovh.net"], ["ovhcloud"]],
  [["ns200.anycast.me", "dns200.anycast.me"], ["ovhcloud"]],
  [["ns1.digitalocean.com", "ns2.digitalocean.com", "ns3.digitalocean.com"], ["digitalocean"]],
  [["hydrogen.ns.hetzner.com", "oxygen.ns.hetzner.com", "helium.ns.hetzner.de"], ["hetzner"]],
  [["ns1.first-ns.de", "robotns2.second-ns.de", "robotns3.second-ns.com"], ["hetzner"]],
  [["ns1.your-server.de", "ns.second-ns.com", "ns3.second-ns.de"], ["hetzner"]],
  [["ns1.vercel-dns.com", "ns2.vercel-dns.com"], ["vercel"]],
  [
    ["dns1.p01.nsone.net", "dns2.p01.nsone.net"],
    ["squarespace", "netlify"],
  ],
  [["ns10.wixdns.net", "ns11.wixdns.net"], ["wix"]],
  [["ns1.wordpress.com", "ns2.wordpress.com", "ns3.wordpress.com"], ["wordpress-com"]],
  [["ns1.bluehost.com", "ns2.bluehost.com"], ["bluehost"]],
  [["hgns1.hostgator.com", "hgns2.hostgator.com"], ["hostgator"]],
  [["ns1111.hostgator.com", "ns2222.hostgator.com"], ["hostgator"]],
  [["dns3.hostgator.com.br", "dns4.hostgator.com.br"], ["hostgator-br"]],
  [["ns1.siteground.net", "ns2.siteground.net"], ["siteground"]],
  [["a.auto.dns.br", "b.auto.dns.br"], ["registro-br"]],
  [["ns1.locaweb.com.br", "ns2.locaweb.com.br", "ns3.locaweb.com.br"], ["locaweb"]],
  [["dns1.kinghost.com.br", "dns6.kinghost.com.br"], ["kinghost"]],
  [["ns1.dominios.uol.com.br", "ns2.dominios.uol.com.br", "ns3.dominios.uol.com.br"], ["uol-host"]],
  [
    ["ns534.umbler.com", "ns148.umbler.in", "ns283.umbler.com.br", "ns840.umbler.co.uk"],
    ["umbler"],
  ],
  [
    [
      "ns1.dnsimple-edge.com",
      "ns2.dnsimple-edge.net",
      "ns3.dnsimple-edge.io",
      "ns4.dnsimple-edge.org",
    ],
    ["dnsimple"],
  ],
  [["ns1.dnsimple.com", "ns2.dnsimple.com"], ["dnsimple"]],
];

describe("detectDnsHosts", () => {
  it.each(ZONES)("reads %j as %j", (names, hosts) => {
    expect(detectDnsHosts(names)).toEqual(hosts);
  });

  it("never picks between hosts that share names: NS1's go to Netlify and Squarespace", () => {
    expect(detectDnsHosts(["dns1.p03.nsone.net"])).toEqual(["squarespace", "netlify"]);
  });

  it("never picks between hosts that share names: Google's go to Cloud DNS and Squarespace", () => {
    expect(detectDnsHosts(["ns-cloud-c1.googledomains.com"])).toEqual([
      "squarespace",
      "google-cloud-dns",
    ]);
  });

  it("reads names the way DNS may spell them: any case, a trailing dot", () => {
    expect(detectDnsHosts(["ADA.NS.Cloudflare.com.", "bob.ns.cloudflare.com"])).toEqual([
      "cloudflare",
    ]);
  });

  it("answers no host for names nobody claims, a mix of hosts, or no names", () => {
    expect(detectDnsHosts(["ns1.acme.com", "ns2.acme.com"])).toEqual([]);
    expect(detectDnsHosts(["ada.ns.cloudflare.com", "ns1.digitalocean.com"])).toEqual([]);
    expect(detectDnsHosts(["ada.ns.cloudflare.com", "ns1.acme.com"])).toEqual([]);
    expect(detectDnsHosts([])).toEqual([]);
    expect(detectDnsHosts(["", " "])).toEqual([]);
  });

  it("leaves Hostinger's names alone: only a search snippet has them, so the picker is the way in", () => {
    expect(detectDnsHosts(["ns1.dns-parking.com", "ns2.dns-parking.com"])).toEqual([]);
  });

  it("matches a whole name, never a name that only ends the same way", () => {
    expect(detectDnsHosts(["ada.ns.cloudflare.com.evil.net"])).toEqual([]);
    expect(detectDnsHosts(["evilns1.digitalocean.com"])).toEqual([]);
    expect(detectDnsHosts(["ns1.digitalocean.com.br"])).toEqual([]);
  });

  it("has a fixture for every pattern of every host", () => {
    const names = ZONES.flatMap(([zone]) => zone);
    for (const id of DNS_HOST_IDS)
      for (const pattern of DNS_HOSTS[id].ns)
        expect(
          names.some((name) => pattern.test(name)),
          `${id} ${String(pattern)}`,
        ).toBe(true);
  });
});

describe("the host data", () => {
  const hosts = DNS_HOST_IDS.map((id) => [id, DNS_HOSTS[id]] as const);
  const flagged = (kind: DnsTrapKind) =>
    hosts.filter(([, host]) => trapOf(host, kind)).map(([id]) => id);

  it("holds exactly the ids, and only Hostinger and cPanel have no pattern", () => {
    expect(Object.keys(DNS_HOSTS).sort()).toEqual([...DNS_HOST_IDS].sort());
    expect(hosts.filter(([, host]) => !host.ns.length).map(([id]) => id)).toEqual([
      "hostinger",
      "cpanel",
    ]);
  });

  it.each(hosts)("%s: patterns are anchored and lowercase", (_id, host) => {
    for (const pattern of host.ns) {
      expect(pattern.source.startsWith("^")).toBe(true);
      expect(pattern.source.endsWith("$")).toBe(true);
      expect(pattern.flags).toBe("");
      expect(pattern.source).toBe(pattern.source.toLowerCase());
    }
  });

  it.each(hosts)("%s: a link is https and a label is neither blank nor padded", (_id, host) => {
    if (host.link) expect(host.link.startsWith("https://")).toBe(true);
    const labels = [
      host.open,
      host.add,
      host.save,
      host.cname.name,
      host.cname.value,
      host.txt.name,
      host.txt.value,
    ];
    for (const label of labels)
      if (label !== null) {
        expect(label).not.toBe("");
        expect(label.trim()).toBe(label);
      }
  });

  it("writes no em dash in anything a customer reads", () => {
    expect(JSON.stringify(DNS_HOSTS)).not.toContain("—");
  });

  it("quotes the label a trap names", () => {
    for (const [, host] of hosts)
      for (const trap of host.traps) {
        if (trap.kind === "proxyOff") expect(trap.field && trap.value).toBeTruthy();
        if (trap.kind === "secondSave") expect(trap.button).toBeTruthy();
        if (trap.kind === "advancedMode") expect(trap.mode).toBeTruthy();
      }
  });

  it("flags the traps the research found, and no trap twice on one host", () => {
    expect(flagged("trailingDot")).toEqual(["ovhcloud", "digitalocean", "hetzner"]);
    expect(flagged("quotedTxt")).toEqual(["route53", "hetzner"]);
    expect(flagged("proxyOff")).toEqual(["cloudflare"]);
    expect(flagged("secondSave")).toEqual(["kinghost"]);
    expect(flagged("advancedMode")).toEqual(["registro-br"]);
    for (const [, host] of hosts) {
      const kinds = host.traps.map((trap) => trap.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it("keeps the labels in the language of the host's own page", () => {
    expect(DNS_HOSTS.kinghost.traps).toContainEqual({
      kind: "secondSave",
      button: "SALVAR ALTERAÇÕES",
    });
    expect(DNS_HOSTS.kinghost.open).toBe("Gerenciar DNS");
    expect(DNS_HOSTS["registro-br"].traps).toContainEqual({
      kind: "advancedMode",
      mode: "Modo Avançado",
    });
  });
});

describe("normalizeDnsName", () => {
  it.each([
    [" EXAMPLE.COM.\n", "example.com"],
    ["example.com..", "example.com."],
    ["example.com...", "example.com.."],
    ["example..com", "example..com"],
    ["EXAMPLE.COM .", "example.com "],
    [" BÜCHER.EXAMPLE. ", "bücher.example"],
    ["example.com。", "example.com。"],
    ["[2001:DB8::1].", "[2001:db8::1]"],
    [".", ""],
    [" \t", ""],
  ])("reads %j as %j without validating or converting IDNA", (name, expected) => {
    expect(normalizeDnsName(name)).toBe(expected);
  });
});
