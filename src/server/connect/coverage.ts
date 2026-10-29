// Which DNS providers have switched on one of our templates? A provider answers the same
// question for every zone it hosts (`GET {urlAPI}/v2/domainTemplates/providers/<providerId>/
// services/<serviceId>`: 200 yes, 404 no), so asking once per provider is enough. The Templates
// repository only shows what was merged, not what a provider turned on; this is the check that
// does.
import { fetchBounded, type FetchFn } from "../../bounded-fetch.ts";
import { CONNECT_PROVIDERS, type ConnectProvider } from "./providers.ts";

export type TemplateSupport = "supported" | "not_supported" | "unanswered";

/** The answer of each provider, by our id for it (`cloudflare`). A status that says "not now"
 *  (429, 5xx), a failed request or a redirect is `unanswered`, never "no". */
export async function templateCoverage(
  io: { fetch?: FetchFn },
  args: {
    providerId: string;
    serviceId: string;
    timeoutMs?: number;
    providers?: readonly ConnectProvider[];
  },
): Promise<Record<string, TemplateSupport>> {
  const { providerId, serviceId, timeoutMs = 5_000, providers = CONNECT_PROVIDERS } = args;
  const answers = await Promise.all(
    providers.map(async (provider): Promise<[string, TemplateSupport]> => {
      const answer = await fetchBounded(
        io.fetch ?? fetch,
        `${provider.api}/v2/domainTemplates/providers/${providerId}/services/${serviceId}`,
        { method: "GET", headers: { Accept: "application/json" } },
        { timeoutMs, maxBytes: 64 * 1024 },
      );
      if (answer?.status === 200) return [provider.id, "supported"];
      if (answer?.status === 404) return [provider.id, "not_supported"];
      return [provider.id, "unanswered"];
    }),
  );
  return Object.fromEntries(answers);
}
