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
// WordPress.com, Domain Chief) join the same way.
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
  /** Verified by a live test: a second apply of the same template keeps the first one's records,
   *  because the provider honors `multiInstance` or keeps no template state and merges SPFM.
   *  Omitted means unverified. */
  supportsMultiInstance?: boolean;
}

export const CONNECT_PROVIDERS: readonly ConnectProvider[] = [
  // `_domainconnect.colding.app` read 2026-10-29; settings answer `urlSyncUX`
  // https://dash.cloudflare.com/domainconnect.
  {
    id: "cloudflare",
    txt: "api.cloudflare.com/client/v4/dns/domainconnect",
    api: "https://api.cloudflare.com/client/v4/dns/domainconnect",
    syncHost: "dash.cloudflare.com",
    // Unverified. Cloudflare ignores the multiInstance flag and documents merging SPFM into the
    // existing record: https://developers.cloudflare.com/dns/reference/domain-connect/#template-definition
    // Whether a second apply keeps the first include is untested. It answers the template query
    // with only its version, so a caller also passes `instanceTemplateVersion`.
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
  // `_domainconnect.glauca.digital` read 2026-11-07: a CNAME to
  // `domain-connect.as207960.ltd.uk`. Settings use a separate `/api` path for templates.
  {
    id: "glauca",
    txt: "dns.glauca.digital/connect",
    api: "https://dns.glauca.digital/connect/api",
    syncHost: "dns.glauca.digital",
  },
  // Settings read 2026-10-29 from domainconnect.api.godaddy.com (`urlSyncUX`
  // https://dcc.godaddy.com/manage). The TXT value on a customer's zone is not read yet: if it
  // differs, GoDaddy answers "not offered", which is the safe way to be wrong.
  // GoDaddy told us on 2026-10-29 that it is "not currently accepting new templates for direct
  // onboarding", with no timeline. It supports many templates already (9 of 12 third-party ones
  // we probed), so the entry stays for them, but a template of yours answers "not offered" there.
  {
    id: "godaddy",
    txt: "domainconnect.api.godaddy.com",
    api: "https://domainconnect.api.godaddy.com",
    syncHost: "dcc.godaddy.com",
  },
];
