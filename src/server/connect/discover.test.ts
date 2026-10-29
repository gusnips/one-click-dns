// Discovery against a fake DNS and a fake provider: nothing here calls a real provider. The
// answers are the shapes read from Cloudflare on 2026-10-29: the `_domainconnect` TXT, the
// settings body, and the 404 a template the provider hasn't onboarded gets.
import { describe, expect, it } from "bun:test";
import { discoverConnect } from "./discover.ts";

const CLOUDFLARE_TXT = "api.cloudflare.com/client/v4/dns/domainconnect";
const API = `https://${CLOUDFLARE_TXT}`;
const PROVIDER_ID = "example.com";
const SETTINGS = {
  providerId: "cloudflare.com",
  providerName: "cloudflare",
  providerDisplayName: "Cloudflare",
  urlSyncUX: "https://dash.cloudflare.com/domainconnect",
  urlAPI: API,
};

/** The provider, answering by URL. Every URL asked is kept, with what it was asked with, so a
 *  test can say none was. */
function fakeProvider(answers: Record<string, Response | (() => Promise<Response>)>) {
  const asked: string[] = [];
  const inits: RequestInit[] = [];
  // `typeof fetch` also carries statics (`preconnect`) a fake has no use for: the call shape is all
  // the code under test relies on.
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push(url);
    inits.push(init);
    const answer = answers[url];
    if (!answer) return new Response("{}", { status: 404 });
    return typeof answer === "function" ? answer() : answer;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, inits };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settingsUrl = (zone: string) => `${API}/v2/${zone}/settings`;
const templateUrl = (service: string) =>
  `${API}/v2/domainTemplates/providers/${PROVIDER_ID}/services/${service}`;

const dnsWith = (txt: string[] | "failed" | "absent") => async () =>
  txt === "failed" || txt === "absent" ? txt : { txts: txt };

const ask = (
  txt: string[] | "failed" | "absent",
  fetch?: ReturnType<typeof fakeProvider>["fetch"],
  budgetMs = 2_000,
) =>
  discoverConnect(
    { txt: dnsWith(txt), fetch },
    { zone: "acme.io", providerId: PROVIDER_ID, serviceId: "dmarc", budgetMs },
  );

describe("discoverConnect", () => {
  it("finds the provider that has our template, and names where to send the person", async () => {
    const { fetch, asked } = fakeProvider({
      [settingsUrl("acme.io")]: json(SETTINGS),
      [templateUrl("dmarc")]: json({}),
    });
    expect(await ask([CLOUDFLARE_TXT], fetch)).toEqual({
      found: true,
      id: "cloudflare",
      provider: "Cloudflare",
      syncUrl: "https://dash.cloudflare.com/domainconnect",
    });
    expect(asked).toEqual([settingsUrl("acme.io"), templateUrl("dmarc")]);
  });

  it("answers not_offered while the provider hasn't onboarded our template (a 404)", async () => {
    const { fetch } = fakeProvider({ [settingsUrl("acme.io")]: json(SETTINGS) });
    expect(await ask([CLOUDFLARE_TXT], fetch)).toEqual({ found: false, reason: "not_offered" });
  });

  it("asks the settings at the TXT's address and the template at the settings' own API", async () => {
    const txt = "domainconnect.vercel.com";
    const api = "https://vercel.com/api/domain-connect";
    const { fetch, asked } = fakeProvider({
      [`https://${txt}/v2/acme.io/settings`]: json({
        providerName: "Vercel",
        urlSyncUX: "https://vercel.com/domain-connect",
        urlAPI: api,
      }),
      [`${api}/v2/domainTemplates/providers/${PROVIDER_ID}/services/dmarc`]: json({}),
    });
    expect(await ask([txt], fetch)).toMatchObject({
      found: true,
      id: "vercel",
      syncUrl: "https://vercel.com/domain-connect",
    });
    expect(asked[0]).toBe(`https://${txt}/v2/acme.io/settings`);
    expect(asked[1]).toBe(`${api}/v2/domainTemplates/providers/${PROVIDER_ID}/services/dmarc`);
  });

  it("never calls a host a customer's TXT names unless the whole value is on the list", async () => {
    for (const value of [
      "evil.example/client/v4/dns/domainconnect",
      "api.cloudflare.com/client/v4/dns/domainconnect/../../../internal",
      "api.cloudflare.com/elsewhere",
      "api.cloudflare.com.evil.example/client/v4/dns/domainconnect",
      "169.254.169.254",
    ]) {
      const { fetch, asked } = fakeProvider({});
      expect(await ask([value], fetch), value).toEqual({ found: false, reason: "not_offered" });
      expect(asked, value).toEqual([]);
    }
  });

  it("reads the value as the library does: quotes, case and a trailing slash don't matter", async () => {
    const { fetch } = fakeProvider({
      [settingsUrl("acme.io")]: json(SETTINGS),
      [templateUrl("dmarc")]: json({}),
    });
    expect(await ask([`"API.Cloudflare.com/client/v4/dns/domainconnect/"`], fetch)).toMatchObject({
      found: true,
      syncUrl: "https://dash.cloudflare.com/domainconnect",
    });
  });

  it("refuses settings that point the API or the person's browser at another host", async () => {
    for (const settings of [
      { ...SETTINGS, urlAPI: "https://evil.example/client/v4/dns/domainconnect" },
      { ...SETTINGS, urlAPI: "http://api.cloudflare.com/client/v4/dns/domainconnect" },
      { ...SETTINGS, urlSyncUX: "https://evil.example/domainconnect" },
      { ...SETTINGS, urlSyncUX: "https://user:pw@dash.cloudflare.com/domainconnect" },
      { ...SETTINGS, urlSyncUX: undefined },
      { providerName: "cloudflare" },
    ]) {
      const { fetch, asked } = fakeProvider({ [settingsUrl("acme.io")]: json(settings) });
      expect(await ask([CLOUDFLARE_TXT], fetch)).toEqual({ found: false, reason: "not_offered" });
      // The template is never asked of a provider whose settings we refused.
      expect(asked).toEqual([settingsUrl("acme.io")]);
    }
  });

  it("never follows a redirect: a 3xx is an answer, and not one we use", async () => {
    const { fetch, asked, inits } = fakeProvider({
      [settingsUrl("acme.io")]: new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/" },
      }),
    });
    expect(await ask([CLOUDFLARE_TXT], fetch)).toEqual({ found: false, reason: "not_offered" });
    expect(asked).toEqual([settingsUrl("acme.io")]);
    expect(inits[0]).toMatchObject({ redirect: "manual" });
  });

  it("reads DNS or a provider that didn't answer as unanswered, and DNS that says none as not_offered", async () => {
    expect(await ask("failed")).toEqual({ found: false, reason: "unanswered" });
    expect(await ask("absent")).toEqual({ found: false, reason: "not_offered" });
    const busy = fakeProvider({ [settingsUrl("acme.io")]: json({}, 503) });
    expect(await ask([CLOUDFLARE_TXT], busy.fetch)).toEqual({
      found: false,
      reason: "unanswered",
    });
    const broken = fakeProvider({
      [settingsUrl("acme.io")]: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(await ask([CLOUDFLARE_TXT], broken.fetch)).toEqual({
      found: false,
      reason: "unanswered",
    });
  });

  it("gives up when the budget runs out, whatever is still running", async () => {
    const stuck = fakeProvider({
      [settingsUrl("acme.io")]: () => new Promise<Response>(() => undefined),
    });
    expect(await ask([CLOUDFLARE_TXT], stuck.fetch, 50)).toEqual({
      found: false,
      reason: "unanswered",
    });
  });

  it("puts only a plain DNS name into the URL path", async () => {
    const { fetch, asked } = fakeProvider({});
    for (const zone of ["acme.io/../x", "acme.io?x=1", "ACME.io", "localhost"]) {
      const answer = await discoverConnect(
        { txt: dnsWith([CLOUDFLARE_TXT]), fetch },
        { zone, providerId: PROVIDER_ID, serviceId: "dmarc", budgetMs: 2_000 },
      );
      expect(answer, zone).toEqual({ found: false, reason: "not_offered" });
    }
    expect(asked).toEqual([]);
  });
});
