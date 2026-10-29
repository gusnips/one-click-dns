// Does this zone's DNS provider add our records in one click? Three questions in turn, from the
// Domain Connect spec's discovery:
//
//   1. the TXT at `_domainconnect.<zone>`, which names the provider's API;
//   2. that API's `/v2/<zone>/settings`, which names the page to send the person to;
//   3. `{urlAPI}/v2/domainTemplates/providers/<providerId>/services/<serviceId>`, where 200 says
//      the provider has our template and 404 says it hasn't.
//
// The TXT is the customer's own, so what it names is asked only when it is on the allowlist
// (./providers.ts), and what the settings then name must be that entry's own hosts. Every request
// is bounded and never follows a redirect. The whole thing runs inside one time budget, and a
// budget that runs out, a failed lookup or a failed request is "unanswered", never an error:
// the person still has the records to copy.
import { fetchBounded, type BoundedAnswer } from "../../bounded-fetch.ts";
import { isObject } from "../../guards.ts";
import type { DnsLookups } from "../dns.ts";
import { CONNECT_PROVIDERS, type ConnectProvider } from "./providers.ts";

/** The most a provider's answer may weigh. Settings and template checks are a few hundred bytes. */
const MAX_ANSWER_BYTES = 64 * 1024;

export interface DiscoveryIo {
  txt: DnsLookups["txt"];
  fetch?: typeof fetch;
}

export type Discovery =
  | {
      found: true;
      /** Our id for the provider (`cloudflare`). */
      id: string;
      /** The provider's own name for itself, as its settings give it. */
      provider: string;
      /** `urlSyncUX`, without a trailing slash: where the apply path goes. */
      syncUrl: string;
    }
  | { found: false; reason: "not_offered" | "unanswered" };

const NOT_OFFERED = { found: false, reason: "not_offered" } as const;
const UNANSWERED = { found: false, reason: "unanswered" } as const;

/** A zone as it goes into a URL path: DNS labels and dots, nothing else. The caller's zone came
 *  from a hostname we already parsed, and this holds the line if a caller ever forgets. */
const ZONE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** What a provider's settings must hold for us to use them. The rest is ignored. */
interface Settings {
  providerName: string;
  providerDisplayName?: string;
  urlSyncUX?: string;
  urlAPI: string;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

function readSettings(body: unknown): Settings | null {
  if (!isObject(body)) return null;
  const providerName = text(body.providerName, 100);
  const urlAPI = text(body.urlAPI, 512);
  if (!providerName || !urlAPI) return null;
  return {
    providerName,
    providerDisplayName: text(body.providerDisplayName, 100),
    urlSyncUX: text(body.urlSyncUX, 512),
    urlAPI,
  };
}

/** The TXT value as the library reads it: no quotes around it, no case, no trailing slash. */
const normalizeTxt = (value: string) =>
  value
    .trim()
    .replace(/^"+|"+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");

/** An https address with no credentials and no port of its own, or null. */
function plainHttps(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const plain = url.protocol === "https:" && !url.username && !url.password && !url.port;
    return plain ? url : null;
  } catch {
    return null;
  }
}

const withoutTrailingSlash = (url: URL) => `${url.origin}${url.pathname}`.replace(/\/+$/, "");

/** A status that says "not now" rather than "no": try again later. */
const transient = (status: number) => status === 429 || status >= 500;

/**
 * The provider that can add `serviceId` to `zone`, or why none can. `budgetMs` covers all three
 * questions together; a lookup still running when it ends is left behind.
 */
export async function discoverConnect(
  io: DiscoveryIo,
  args: {
    zone: string;
    /** The provider id our templates are filed under (`DomainConnectIdentity.providerId`). */
    providerId: string;
    serviceId: string;
    budgetMs: number;
    providers?: readonly ConnectProvider[];
  },
): Promise<Discovery> {
  if (!ZONE.test(args.zone)) return NOT_OFFERED;
  const deadline = Date.now() + args.budgetMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<Discovery>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED), args.budgetMs);
  });
  try {
    return await Promise.race([ask(io, args, deadline), outOfTime]);
  } catch {
    return UNANSWERED;
  } finally {
    clearTimeout(timer);
  }
}

async function ask(
  io: DiscoveryIo,
  args: Parameters<typeof discoverConnect>[1],
  deadline: number,
): Promise<Discovery> {
  const { zone, providerId, serviceId, providers = CONNECT_PROVIDERS } = args;

  /** One GET to the allowlist, within what is left of the budget; null when none came. */
  const get = (url: string): Promise<BoundedAnswer | null> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.resolve(null);
    return fetchBounded(
      io.fetch ?? fetch,
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { timeoutMs: left, maxBytes: MAX_ANSWER_BYTES },
    );
  };

  const published = await io.txt(`_domainconnect.${zone}`);
  if (published === "failed") return UNANSWERED;
  if (published === "absent") return NOT_OFFERED;
  const values = published.txts.map(normalizeTxt);
  const provider = providers.find((entry) => values.includes(entry.txt));
  if (!provider) return NOT_OFFERED;

  // The settings are asked at the address the TXT names, which is not always the API's.
  const settings = await get(`https://${provider.txt}/v2/${zone}/settings`);
  if (!settings) return UNANSWERED;
  if (settings.status !== 200) return transient(settings.status) ? UNANSWERED : NOT_OFFERED;
  let body: unknown;
  try {
    body = JSON.parse(settings.text);
  } catch {
    return NOT_OFFERED;
  }
  const parsed = readSettings(body);
  if (!parsed) return NOT_OFFERED;
  const api = plainHttps(parsed.urlAPI);
  const sync = parsed.urlSyncUX ? plainHttps(parsed.urlSyncUX) : null;
  // We call the first and send the person's browser to the second: both must be the entry's own.
  if (!api || withoutTrailingSlash(api) !== provider.api) return NOT_OFFERED;
  if (!sync || sync.hostname !== provider.syncHost || sync.search || sync.hash) return NOT_OFFERED;

  const template = await get(
    `${provider.api}/v2/domainTemplates/providers/${providerId}/services/${serviceId}`,
  );
  if (!template) return UNANSWERED;
  if (template.status !== 200) return transient(template.status) ? UNANSWERED : NOT_OFFERED;
  return {
    found: true,
    id: provider.id,
    provider: parsed.providerDisplayName?.trim() || parsed.providerName,
    syncUrl: withoutTrailingSlash(sync),
  };
}
