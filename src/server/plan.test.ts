// The plan against a fake DNS and a fake provider: nothing here asks the network.
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { planConnection, type PlanInput } from "./plan.ts";
import type { ConnectProvider } from "./connect/providers.ts";

const CLOUDFLARE_NS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
const CLOUDFLARE_TXT = "api.cloudflare.com/client/v4/dns/domainconnect";
const API = `https://${CLOUDFLARE_TXT}`;
const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

/** A zone `acme.io` on the given name servers, with the TXT records by name. */
function io(ns: string[] | "failed", txt: Record<string, string[]> = {}, hasTemplate = true) {
  const asked: string[] = [];
  return {
    asked,
    ns: async (name: string) =>
      ns === "failed" ? "failed" : name === "acme.io" ? { names: ns } : "absent",
    cname: async () => "absent" as const,
    txt: async (name: string) => (txt[name] ? { txts: txt[name] } : ("absent" as const)),
    fetch: async (url: string) => {
      asked.push(url);
      if (url === `${API}/v2/acme.io/settings`)
        return Response.json({
          providerName: "cloudflare",
          providerDisplayName: "Cloudflare",
          urlSyncUX: "https://dash.cloudflare.com/domainconnect",
          urlAPI: API,
        });
      return hasTemplate ? Response.json({}) : new Response("{}", { status: 404 });
    },
  };
}

const connect: NonNullable<PlanInput["connect"]> = {
  providerId: "example.com",
  keyId: "_dck1",
  serviceId: "cname",
  privateKeyPem,
  params: (zone) => ({ domain: zone, host: "help", target: "a1b2" }),
};

describe("planConnection", () => {
  it("offers the signed link first, then the token, then the steps, for Cloudflare", async () => {
    const plan = await planConnection(
      { hostname: "help.acme.io", connect },
      io(CLOUDFLARE_NS, { "_domainconnect.acme.io": [CLOUDFLARE_TXT] }),
    );
    expect(plan.methods.map((m) => m.kind)).toEqual(["domain-connect", "api-token", "manual"]);
    const [link] = plan.methods;
    expect(link).toMatchObject({ kind: "domain-connect", provider: "Cloudflare" });
    expect(link?.kind === "domain-connect" && link.url).toContain(
      "https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/example.com/services/cname/apply?domain=acme.io&host=help&target=a1b2&key=_dck1&sig=",
    );
    expect(plan.reading?.hosts).toEqual(["cloudflare"]);
  });

  it("leaves out the link when the provider hasn't our template, and says nothing was unanswered", async () => {
    const plan = await planConnection(
      { hostname: "help.acme.io", connect },
      io(CLOUDFLARE_NS, { "_domainconnect.acme.io": [CLOUDFLARE_TXT] }, false),
    );
    expect(plan.methods.map((m) => m.kind)).toEqual(["api-token", "manual"]);
    expect(plan.connectUnanswered).toBe(false);
  });

  it("passes the instance requirement on, so a provider not verified for it offers no link", async () => {
    const plan = await planConnection(
      {
        hostname: "help.acme.io",
        connect: { ...connect, requireMultiInstance: true, instanceTemplateVersion: 1 },
      },
      io(CLOUDFLARE_NS, { "_domainconnect.acme.io": [CLOUDFLARE_TXT] }),
    );
    expect(plan.methods.map((m) => m.kind)).toEqual(["api-token", "manual"]);
    expect(plan.connectUnanswered).toBe(false);
  });

  it("offers the link from a provider verified for separate instances once its version shows our filing", async () => {
    // A synthetic provider, not a claim about a real one.
    const VERIFIED: ConnectProvider = {
      id: "example",
      txt: "connect.example.test",
      api: "https://connect.example.test",
      syncHost: "dns.example.test",
      supportsMultiInstance: true,
    };
    const verified = (template: unknown) => ({
      ns: async (name: string) =>
        name === "acme.io" ? { names: ["ns1.example.test"] } : ("absent" as const),
      cname: async () => "absent" as const,
      txt: async (name: string) =>
        name === "_domainconnect.acme.io" ? { txts: [VERIFIED.txt] } : ("absent" as const),
      fetch: async (url: string) =>
        url === `${VERIFIED.api}/v2/acme.io/settings`
          ? Response.json({
              providerName: "Example",
              urlSyncUX: "https://dns.example.test/apply",
              urlAPI: VERIFIED.api,
            })
          : Response.json(template),
    });
    const ask = (filed: number) =>
      planConnection(
        {
          hostname: "help.acme.io",
          connect: {
            ...connect,
            requireMultiInstance: true,
            instanceTemplateVersion: filed,
            providers: [VERIFIED],
          },
        },
        verified({ version: 2 }),
      );
    expect((await ask(2)).methods[0]).toMatchObject({
      kind: "domain-connect",
      provider: "Example",
    });
    expect((await ask(3)).methods.map((m) => m.kind)).not.toContain("domain-connect");
  });

  it("offers no link when the app has no template, and no token for a host without a writer", async () => {
    const plan = await planConnection(
      { hostname: "help.acme.io" },
      io(["ns45.domaincontrol.com", "ns46.domaincontrol.com"]),
    );
    expect(plan.methods).toEqual([{ kind: "manual", hosts: ["godaddy"] }]);
  });

  it("never picks a host for a token when the names fit several", async () => {
    const plan = await planConnection(
      { hostname: "help.acme.io" },
      io(["ns-cloud-a1.googledomains.com", "ns-cloud-a2.googledomains.com"]),
    );
    expect(plan.methods).toEqual([{ kind: "manual", hosts: ["squarespace", "google-cloud-dns"] }]);
  });

  it("is only the steps, with no reading, when DNS didn't answer", async () => {
    const plan = await planConnection({ hostname: "help.acme.io", connect }, io("failed"));
    expect(plan).toEqual({
      reading: null,
      methods: [{ kind: "manual", hosts: [] }],
      connectUnanswered: false,
    });
  });
});
