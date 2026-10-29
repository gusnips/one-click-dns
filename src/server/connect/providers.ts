// The DNS providers we will call for Domain Connect: the ones whose `_domainconnect` value and
// settings were read, and no others.
//
// A customer controls their own `_domainconnect` TXT record, and what it names is where we would
// send a request. So a name read from a customer's DNS is never dialled. Only a value equal to an
// entry here is, and the settings the provider answers must then name that entry's own hosts.
//
// ponytail: one code change per provider. The ceiling is the release a new provider waits for;
// the upgrade is a guarded, pinned fetch (`fetchPublic` in `@gusnips/server/node`, behind the
// public-address guard) so any host that answers `_domainconnect` can be asked without a release.
// A provider joins when its value has been read from DNS and its settings from its API. The ones
// the Domain Connect list names live and that are not here yet (IONOS, NameSilo, Plesk,
// WordPress.com, Domain Chief, Glauca Digital) join the same way.
export interface ConnectProvider {
  /** Our id for the provider. */
  id: string;
  /** The whole `_domainconnect` TXT value: host and path, no scheme, no trailing slash, as the
   *  reference library reads it (`https://<value>/v2/<zone>/settings`). Not just the host, so a
   *  path of a customer's choosing on an allowed host is refused as well. */
  txt: string;
  /** The `urlAPI` the settings must name, `https://` and no trailing slash: where the template
   *  check goes. It is the TXT's own address for most providers, not for all. */
  api: string;
  /** The one host the settings' `urlSyncUX` may name: the page we send the person's browser to. */
  syncHost: string;
}

export const CONNECT_PROVIDERS: readonly ConnectProvider[] = [
  // `_domainconnect.colding.app` read 2026-10-29; settings answer `urlSyncUX`
  // https://dash.cloudflare.com/domainconnect.
  {
    id: "cloudflare",
    txt: "api.cloudflare.com/client/v4/dns/domainconnect",
    api: "https://api.cloudflare.com/client/v4/dns/domainconnect",
    syncHost: "dash.cloudflare.com",
  },
  // `_domainconnect.nextjs.org` read 2026-10-29: a CNAME to `_domainconnect.vercel-dns.com`, whose
  // TXT is `domainconnect.vercel.com`. The settings name another address for the API.
  {
    id: "vercel",
    txt: "domainconnect.vercel.com",
    api: "https://vercel.com/api/domain-connect",
    syncHost: "vercel.com",
  },
  // `_domainconnect.simply.com` read 2026-10-29.
  {
    id: "simply",
    txt: "domainconnect.simply.com",
    api: "https://domainconnect.simply.com",
    syncHost: "domainconnect.simply.com",
  },
  // Settings read 2026-10-29 from domainconnect.api.godaddy.com (`urlSyncUX`
  // https://dcc.godaddy.com/manage). The TXT value on a customer's zone is not read yet: if it
  // differs, GoDaddy answers "not offered", which is the safe way to be wrong.
  {
    id: "godaddy",
    txt: "domainconnect.api.godaddy.com",
    api: "https://domainconnect.api.godaddy.com",
    syncHost: "dcc.godaddy.com",
  },
];
