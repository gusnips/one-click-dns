import { describe, expect, it } from "bun:test";
import {
  cnameTemplate,
  dkimTemplate,
  dmarcTemplate,
  mxTemplate,
  spfTemplate,
  templateFileName,
  verificationTemplate,
  type DomainConnectTemplate,
  type TemplateIdentity,
} from "./templates.ts";

const COLDING: TemplateIdentity = {
  providerId: "getcolding.com",
  providerName: "colding",
  logoUrl: "https://colding.app/logo.svg",
  syncPubKeyDomain: "getcolding.com",
  syncRedirectDomain: "console.colding.app",
};

describe("the presets fit what is already filed", () => {
  it("regenerates colding's tracking-domain template exactly", () => {
    expect(
      cnameTemplate(COLDING, {
        serviceId: "tracking-domain",
        serviceName: "Open and click tracking domain",
        description:
          "Points your tracking subdomain at colding, so campaign emails can load their tracking image and tracked links from your own domain. The subdomain is the host parameter.",
        variableDescription:
          "%target%: the label colding gave this tracking domain, which sits under cname.getcolding.com.",
        pointsTo: "%target%.cname.getcolding.com",
      }),
    ).toEqual({
      providerId: "getcolding.com",
      providerName: "colding",
      serviceId: "tracking-domain",
      serviceName: "Open and click tracking domain",
      version: 1,
      logoUrl: "https://colding.app/logo.svg",
      description:
        "Points your tracking subdomain at colding, so campaign emails can load their tracking image and tracked links from your own domain. The subdomain is the host parameter.",
      variableDescription:
        "%target%: the label colding gave this tracking domain, which sits under cname.getcolding.com.",
      syncPubKeyDomain: "getcolding.com",
      syncRedirectDomain: "console.colding.app",
      hostRequired: true,
      records: [{ type: "CNAME", host: "@", pointsTo: "%target%.cname.getcolding.com", ttl: 3600 }],
    });
  });

  it("regenerates colding's dmarc template exactly", () => {
    expect(dmarcTemplate(COLDING)).toEqual({
      providerId: "getcolding.com",
      providerName: "colding",
      serviceId: "dmarc",
      serviceName: "DMARC record for your sending domain",
      version: 1,
      logoUrl: "https://colding.app/logo.svg",
      description:
        "Adds a DMARC record that only monitors (p=none), so mailbox providers can see that your sending domain has a policy. It rejects and quarantines nothing.",
      syncPubKeyDomain: "getcolding.com",
      syncRedirectDomain: "console.colding.app",
      records: [
        {
          type: "TXT",
          host: "_dmarc",
          data: "v=DMARC1; p=none",
          ttl: 3600,
          txtConflictMatchingMode: "Prefix",
          txtConflictMatchingPrefix: "v=DMARC1",
          essential: "OnApply",
        },
      ],
    });
  });
});

describe("every preset follows the Templates repository's rules", () => {
  const all: DomainConnectTemplate[] = [
    cnameTemplate(COLDING, { pointsTo: "%target%.cname.getcolding.com" }),
    dmarcTemplate(COLDING),
    dmarcTemplate(COLDING, { rua: true, serviceId: "dmarc-reports" }),
    spfTemplate(COLDING),
    dkimTemplate(COLDING),
    dkimTemplate(COLDING, { keys: 3, serviceId: "dkim-three" }),
    mxTemplate(COLDING, { pointsTo: "mx.getcolding.com" }),
    verificationTemplate(COLDING, { prefix: "colding-verification=" }),
  ];

  it("always names the key domain, and where a link may come back to", () => {
    for (const t of all) {
      expect(t.syncPubKeyDomain, t.serviceId).toBe("getcolding.com");
      expect(t.syncRedirectDomain, t.serviceId).toBe("console.colding.app");
    }
  });

  it("writes SPF as SPFM at the apex, never as a TXT (DCTL1014)", () => {
    const spf = spfTemplate(COLDING).records;
    expect(spf).toEqual([{ type: "SPFM", host: "@", spfRules: "include:%include%" }]);
    for (const t of all)
      for (const r of t.records)
        if (r.type === "TXT") expect(r.data, t.serviceId).not.toMatch(/^v=spf1/i);
  });

  it("never writes %host% in a host (DCTL1024), nor a bare variable as the whole label", () => {
    for (const t of all)
      for (const r of t.records) {
        expect(r.host, t.serviceId).not.toContain("%host%");
        expect(r.host, t.serviceId).not.toMatch(/^%[^%]+%$/);
      }
  });

  it("gives a unique TXT a conflict mode, and a record the owner may edit essential: OnApply", () => {
    for (const t of all)
      for (const r of t.records)
        if (r.type === "TXT") {
          expect(r.txtConflictMatchingMode, t.serviceId).toBeDefined();
          expect(r.essential, t.serviceId).toBe("OnApply");
        }
  });

  it("files each under a lowercase providerId.serviceId.json name", () => {
    expect(templateFileName({ providerId: "GetColding.com", serviceId: "DMARC" })).toBe(
      "getcolding.com.dmarc.json",
    );
    expect(new Set(all.map(templateFileName)).size).toBe(all.length);
  });

  it("numbers the DKIM keys, and lists each variable it uses", () => {
    const three = dkimTemplate(COLDING, { keys: 3 });
    expect(three.records.map((r) => r.host)).toEqual([
      "%selector1%._domainkey",
      "%selector2%._domainkey",
      "%selector3%._domainkey",
    ]);
    expect(three.variableDescription).toContain("%target3%");
  });
});
