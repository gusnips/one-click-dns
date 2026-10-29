import { describe, expect, it } from "bun:test";
import { templateCoverage } from "./coverage.ts";
import { CONNECT_PROVIDERS } from "./providers.ts";

const urlOf = (id: string) => {
  const provider = CONNECT_PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`no provider ${id}`);
  return `${provider.api}/v2/domainTemplates/providers/example.com/services/dmarc`;
};

describe("templateCoverage", () => {
  it("asks each provider once, at its own API, and reads 200 as on and 404 as off", async () => {
    const asked: string[] = [];
    const answers = new Map([
      [urlOf("cloudflare"), new Response("{}", { status: 404 })],
      [urlOf("godaddy"), new Response("{}", { status: 200 })],
    ]);
    const coverage = await templateCoverage(
      {
        fetch: async (url) => {
          asked.push(url);
          return answers.get(url) ?? new Response("{}", { status: 404 });
        },
      },
      { providerId: "example.com", serviceId: "dmarc" },
    );
    expect(coverage.godaddy).toBe("supported");
    expect(coverage.cloudflare).toBe("not_supported");
    expect(Object.keys(coverage).sort()).toEqual(CONNECT_PROVIDERS.map((p) => p.id).sort());
    expect(new Set(asked).size).toBe(CONNECT_PROVIDERS.length);
  });

  it("reads a busy, broken, redirecting or slow provider as unanswered, never as no", async () => {
    const answers: Record<string, () => Promise<Response>> = {
      [urlOf("cloudflare")]: async () => new Response("{}", { status: 503 }),
      [urlOf("godaddy")]: async () => new Response("{}", { status: 429 }),
      [urlOf("vercel")]: async () => {
        throw new TypeError("fetch failed");
      },
      [urlOf("simply")]: () => new Promise<Response>(() => undefined),
    };
    const coverage = await templateCoverage(
      { fetch: (url) => answers[url]?.() ?? Promise.reject(new Error("unexpected")) },
      { providerId: "example.com", serviceId: "dmarc", timeoutMs: 30 },
    );
    expect(coverage).toEqual({
      cloudflare: "unanswered",
      godaddy: "unanswered",
      vercel: "unanswered",
      simply: "unanswered",
    });
  });
});
