// The DNS hosts we know steps for: which name servers mean which host, and the few facts that
// change what a person clicks or types. The step sentences are the app's own copy, in its own
// languages; this file is DATA, not copy.
//
// Three rules keep it honest:
// - A name server pattern is here only when the host documents it or it was seen in DNS
//   ("observed" below). A pattern from a search snippet alone is left out: Hostinger has none,
//   and the picker reaches it.
// - A label (a menu, a button, a field) is quoted only when a host's own page shows it, in the
//   language that page is in: KingHost's "SALVAR ALTERAÇÕES" stays Portuguese in every locale.
//   A label the research marks UNVERIFIED is `null`, and the steps read without a quote.
// - A trap is here only when the research found it on the host's own page.
//
// Browser-safe: the screen reads the steps from here, the server reads the patterns.
import { normalizeDnsName } from "./dns-name.ts";

/**
 * The DNS hosts we know steps for. A closed list. Order is the order a picker shows them and a
 * detection lists them in.
 *
 * `cpanel` and `namecheap-hosting` both hand the person cPanel's Zone Editor. `hostinger` and
 * `cpanel` have no name server pattern, so DNS alone never names them: a person picks them by
 * hand.
 */
export const DNS_HOST_IDS = [
  "cloudflare",
  "godaddy",
  "namecheap",
  "namecheap-hosting",
  "squarespace",
  "route53",
  "google-cloud-dns",
  "azure-dns",
  "ionos",
  "hostinger",
  "porkbun",
  "name-com",
  "dynadot",
  "namesilo",
  "gandi",
  "ovhcloud",
  "digitalocean",
  "hetzner",
  "vercel",
  "netlify",
  "wix",
  "wordpress-com",
  "cpanel",
  "bluehost",
  "hostgator",
  "hostgator-br",
  "siteground",
  "registro-br",
  "locaweb",
  "kinghost",
  "uol-host",
  "umbler",
  "dnsimple",
] as const;
export type DnsHostId = (typeof DNS_HOST_IDS)[number];

/** The labels on the form of one record type. */
export interface DnsFields {
  /** The box that takes the record's name. */
  name: string | null;
  /** The box that takes its value: a CNAME's target, or a TXT's text. */
  value: string | null;
}

/**
 * What goes wrong at a host, each with a sentence of its own in the app.
 *
 * - `proxyOff`: a record is proxied by default and the proxy hides it (Cloudflare);
 * - `trailingDot`: without a dot at the end, the host adds the zone to a CNAME's target
 *   (OVHcloud, Hetzner, DigitalOcean);
 * - `quotedTxt`: the host wants straight quotes around a TXT value (Route 53, Hetzner);
 * - `secondSave`: adding the record is not saving it (KingHost);
 * - `advancedMode`: the basic mode can't add the record (Registro.br);
 * - `oneSpf`: the host may already hold an SPF record, and a domain may have only one;
 * - `shortName`: the name box takes only the part before the zone, and the host adds the rest.
 *
 * `trailingDot` and `quotedTxt` also change the value we hand over (`records.ts`).
 */
export type DnsTrap =
  | { kind: "proxyOff"; field: string; value: string }
  | { kind: "trailingDot" }
  | { kind: "quotedTxt" }
  | { kind: "secondSave"; button: string }
  | { kind: "advancedMode"; mode: string }
  | { kind: "oneSpf" }
  | { kind: "shortName" };
export type DnsTrapKind = DnsTrap["kind"];

export interface DnsHost {
  /** The brand, as the company writes it. */
  name: string;
  /** The host's name servers, as patterns over a lowercase name with no trailing dot. A set
   *  of names belongs to this host only when every name matches one of them. Empty: no
   *  pattern we may trust, so the host is reached by the picker alone. */
  ns: readonly RegExp[];
  /** The host's page for a zone's records, only where its own docs link one. */
  link: string | null;
  /** The menu, tab or button that opens the zone's records. */
  open: string | null;
  /** The button that starts a new record. */
  add: string | null;
  /** The button that saves it. */
  save: string | null;
  cname: DnsFields;
  txt: DnsFields;
  /** How the host writes the zone's own name in the name box: `"@"`, empty, or `"."`. `null`
   *  when no page of the host says. */
  root: "@" | "" | "." | null;
  traps: readonly DnsTrap[];
}

const NO_FIELDS: DnsFields = { name: null, value: null };
const SHORT: DnsTrap = { kind: "shortName" };
const TRAILING_DOT: DnsTrap = { kind: "trailingDot" };
const QUOTED_TXT: DnsTrap = { kind: "quotedTxt" };

/** cPanel's Zone Editor, which Namecheap shared hosting and many other hosts hand over as it
 *  is. Its Name box takes the label or the whole name, so no `shortName`. */
const CPANEL_EDITOR = {
  link: null,
  open: "Zone Editor",
  add: "Add Record",
  save: "Save Record",
  cname: { name: "Name", value: "Record" },
  txt: { name: "Name", value: "Record" },
  root: null,
  traps: [],
} satisfies Omit<DnsHost, "name" | "ns">;

export const DNS_HOSTS: Record<DnsHostId, DnsHost> = {
  cloudflare: {
    name: "Cloudflare",
    // Documented: <name>.ns.cloudflare.com, and <color>.foundationdns.{com,net,org}.
    ns: [/^[a-z0-9-]+\.ns\.cloudflare\.com$/, /^[a-z0-9-]+\.foundationdns\.(com|net|org)$/],
    link: "https://dash.cloudflare.com/?to=/:account/:zone/dns/records",
    open: "DNS Records",
    add: "Add record",
    save: "Save",
    cname: { name: "Name", value: "Target" },
    // The dashboard's label for a TXT value is not on a docs page.
    txt: { name: "Name", value: null },
    root: "@",
    traps: [{ kind: "proxyOff", field: "Proxy status", value: "DNS only" }, SHORT],
  },
  godaddy: {
    name: "GoDaddy",
    // Observed: ns<NN>.domaincontrol.com (GoDaddy's docs show only ns1).
    ns: [/^ns\d{1,2}\.domaincontrol\.com$/],
    link: null,
    open: "DNS",
    add: "Add New Record",
    save: "Save",
    cname: { name: "Name", value: "Value" },
    txt: { name: "Name", value: "Value" },
    root: "@",
    traps: [SHORT],
  },
  namecheap: {
    name: "Namecheap",
    // Documented: dns1/2.registrar-servers.com (BasicDNS), pdns1/2 (PremiumDNS),
    // freedns1-5 (FreeDNS).
    ns: [/^(dns|pdns|freedns)\d\.registrar-servers\.com$/],
    link: null,
    open: "Advanced DNS",
    add: "Add New Record",
    save: "Save All Changes",
    cname: { name: "Host", value: "Value" },
    txt: { name: "Host", value: "Value" },
    root: "@",
    traps: [SHORT],
  },
  "namecheap-hosting": {
    name: "Namecheap hosting",
    // Documented: dns1/2.namecheaphosting.com. The records live in cPanel, not Advanced DNS.
    ns: [/^dns\d\.namecheaphosting\.com$/],
    ...CPANEL_EDITOR,
  },
  squarespace: {
    name: "Squarespace",
    ns: [
      // Documented: Google Cloud DNS nameservers "ending in squarespacedns.com".
      /^[a-z0-9-]+\.squarespacedns\.com$/,
      // Observed, listed so that these names read as ambiguous (domains moved from Google
      // Domains sit on Google's names; older Squarespace domains on NS1's).
      /^ns-cloud-[a-z]\d\.googledomains\.com$/,
      /^dns\d\.p\d{2}\.nsone\.net$/,
    ],
    link: null,
    open: "DNS Settings",
    add: "Add record",
    save: "Save",
    cname: { name: "Name", value: "Data" },
    txt: { name: "Name", value: "Text" },
    root: "@",
    traps: [SHORT],
  },
  route53: {
    name: "Amazon Route 53",
    // Documented: ns-<n>.awsdns-<nn>.{com,net,org,co.uk}.
    ns: [/^ns-\d+\.awsdns-\d+\.(com|net|org|co\.uk)$/],
    link: "https://console.aws.amazon.com/route53/v2/hostedzones",
    open: "Hosted zones",
    add: "Create record",
    save: "Create records",
    cname: { name: "Record name", value: "Value" },
    txt: { name: "Record name", value: "Value" },
    // "don't enter a value (for example, an @ symbol) in the Name field".
    root: "",
    traps: [SHORT, QUOTED_TXT],
  },
  "google-cloud-dns": {
    name: "Google Cloud DNS",
    // Documented: ns-cloud-<a-d><1-4>.googledomains.com. Squarespace domains moved from
    // Google Domains use the same names, so a set of them is ambiguous.
    ns: [/^ns-cloud-[a-z]\d\.googledomains\.com$/],
    link: null,
    open: null,
    add: "Add standard",
    save: "Create",
    cname: { name: "DNS name", value: null },
    txt: { name: "DNS name", value: null },
    // "To create a resource record at the domain apex, leave the DNS name field blank."
    root: "",
    traps: [SHORT],
  },
  "azure-dns": {
    name: "Azure DNS",
    // Documented: ns<1-4>-<nn>.azure-dns.{com,net,org,info}.
    ns: [/^ns\d-\d+\.azure-dns\.(com|net|org|info)$/],
    link: null,
    open: "Record sets",
    add: "Add",
    save: "Add",
    cname: { name: "Name", value: null },
    txt: { name: "Name", value: null },
    root: "@",
    traps: [SHORT],
  },
  ionos: {
    name: "IONOS",
    // Documented: ns1<ZZZ>.ui-dns.{de,biz,org,com}, ZZZ from 016 to 126.
    ns: [/^ns1\d{3}\.ui-dns\.(de|biz|org|com)$/],
    link: null,
    open: "DNS",
    add: "Add Record",
    save: "Save",
    // The two articles spell the name box differently.
    cname: { name: "Hostname", value: "Point to" },
    txt: { name: "Host name", value: "Value" },
    root: "@",
    traps: [SHORT],
  },
  hostinger: {
    name: "Hostinger",
    // No pattern: ns1/2.dns-parking.com is a search snippet, never confirmed on a page of
    // theirs. The picker reaches Hostinger.
    ns: [],
    link: null,
    open: "DNS Zone Editor",
    add: null,
    save: "Add Record",
    cname: { name: "Name", value: "Points to" },
    txt: { name: "Name", value: "TXT value" },
    root: "@",
    traps: [SHORT, { kind: "oneSpf" }],
  },
  porkbun: {
    name: "Porkbun",
    // Documented: <city>.ns.porkbun.com.
    ns: [/^[a-z]+\.ns\.porkbun\.com$/],
    link: null,
    open: "DNS",
    add: "Add Record",
    save: "Add",
    cname: { name: "Host", value: "Answer" },
    txt: { name: "Host", value: "Answer" },
    // "If you're adding DNS records to your root domain, you will leave this field blank."
    root: "",
    traps: [SHORT],
  },
  "name-com": {
    name: "Name.com",
    // Observed: ns1<abc>.name.com to ns4<abc>.name.com.
    ns: [/^ns[1-4][a-z]{3}\.name\.com$/],
    link: null,
    open: "Manage DNS Records",
    add: null,
    save: "Add Record",
    cname: { name: "Host", value: "Answer" },
    txt: { name: "Host", value: "Answer" },
    root: null,
    traps: [SHORT],
  },
  dynadot: {
    name: "Dynadot",
    // A Dynadot staff answer on its forum: ns1/2.dyna-ns.net.
    ns: [/^ns\d\.dyna-ns\.net$/],
    link: null,
    open: "DNS Settings",
    add: null,
    save: "Save Settings",
    cname: { name: "Subdomain Record", value: "IP Address or Target Host" },
    txt: NO_FIELDS,
    // The zone's own name goes in a separate "Domain Record" section, never as "@".
    root: null,
    traps: [SHORT],
  },
  namesilo: {
    name: "NameSilo",
    // Documented: ns1-3.dnsowl.com.
    ns: [/^ns\d\.dnsowl\.com$/],
    link: null,
    open: null,
    add: null,
    save: "Submit",
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    // "You can leave the hostname blank ... If you do enter an "@", we will convert that".
    root: "",
    traps: [],
  },
  gandi: {
    name: "Gandi",
    // Observed: ns-<n>-<a|b|c>.gandi.net.
    ns: [/^ns-\d+-[abc]\.gandi\.net$/],
    link: null,
    open: "DNS Records",
    add: "Add",
    save: null,
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: null,
    traps: [SHORT],
  },
  ovhcloud: {
    name: "OVHcloud",
    // Documented: (ns|dns)<nn or nnn>.ovh.net, and (ns|dns)200.anycast.me.
    ns: [/^(ns|dns)\d{2,3}\.ovh\.net$/, /^(ns|dns)200\.anycast\.me$/],
    link: null,
    open: "DNS zone",
    add: "Add an entry",
    save: null,
    cname: { name: "Subdomain", value: "Target" },
    txt: { name: "Subdomain", value: "Target" },
    root: null,
    traps: [SHORT, TRAILING_DOT],
  },
  digitalocean: {
    name: "DigitalOcean",
    // Documented: ns1-3.digitalocean.com.
    ns: [/^ns[1-3]\.digitalocean\.com$/],
    link: null,
    open: "Domains",
    add: "Create a record",
    save: "Create Record",
    cname: { name: "Hostname", value: "Is an alias of" },
    txt: { name: "Hostname", value: "TXT Value" },
    root: "@",
    traps: [SHORT, TRAILING_DOT],
  },
  hetzner: {
    name: "Hetzner",
    ns: [
      // Documented: the primary, secondary (still used by older zones) and konsoleH names.
      /^(hydrogen|oxygen|helium)\.ns\.hetzner\.(com|de)$/,
      /^[a-z0-9]+\.first-ns\.de$/,
      /^[a-z0-9]+\.second-ns\.(de|com)$/,
      /^ns1\.your-server\.de$/,
    ],
    link: null,
    open: "DNS",
    add: null,
    save: "Add",
    cname: { name: "Name", value: "Alias / Value" },
    txt: { name: "Name", value: null },
    root: "@",
    traps: [SHORT, TRAILING_DOT, QUOTED_TXT],
  },
  vercel: {
    name: "Vercel",
    // Documented: ns1-4.vercel-dns.com (the "alternates" are not named).
    ns: [/^ns[1-4]\.vercel-dns\.com$/],
    link: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fdomains",
    open: "Domains",
    add: null,
    save: "Add",
    cname: { name: "Name", value: "Value" },
    txt: { name: "Name", value: "Value" },
    // "Leave Name blank for the root domain."
    root: "",
    traps: [SHORT],
  },
  netlify: {
    name: "Netlify",
    // Documented: "a format similar to dns1.p01.nsone.net". NS1's names are shared with
    // older Squarespace zones, so a set of them is ambiguous.
    ns: [/^dns\d\.p\d{2}\.nsone\.net$/],
    link: null,
    open: "DNS",
    add: "Add new record",
    save: "Save",
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: null,
    traps: [],
  },
  wix: {
    name: "Wix",
    // Observed: ns<n>.wixdns.net. A domain "connected to Wix via pointing" keeps its old
    // name servers, so it never matches here.
    ns: [/^ns\d+\.wixdns\.net$/],
    link: null,
    open: "Manage DNS Records",
    add: "Add Record",
    save: "Save",
    cname: { name: "Host Name", value: "Value" },
    txt: { name: "Host Name", value: "Value" },
    // "Leave this field blank if you were instructed to add an @ sign."
    root: "",
    traps: [],
  },
  "wordpress-com": {
    name: "WordPress.com",
    // Documented: ns1-3.wordpress.com.
    ns: [/^ns[1-3]\.wordpress\.com$/],
    link: "https://wordpress.com/domains/",
    open: "DNS records",
    add: "Add record",
    save: null,
    cname: { name: "Name (host)", value: "Alias of (points to)" },
    txt: { name: "Name", value: "Text" },
    root: "@",
    // The Name box takes the label or the whole name, and ignores quotes around a TXT value.
    traps: [],
  },
  cpanel: {
    // Hosting companies run their own name servers, so there is no pattern: the picker
    // reaches it.
    name: "cPanel",
    ns: [],
    ...CPANEL_EDITOR,
  },
  bluehost: {
    name: "Bluehost",
    // Documented: ns1/2.bluehost.com. Its help is behind a captcha and the menu path was
    // read from a 2024 archive, so no label is quoted.
    ns: [/^ns[12]\.bluehost\.com$/],
    link: null,
    open: null,
    add: null,
    save: null,
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: null,
    traps: [],
  },
  hostgator: {
    name: "HostGator",
    // Documented: hgns1/2.hostgator.com for new customers, ns<NNNN>.hostgator.com before
    // November 2023.
    ns: [/^hgns\d\.hostgator\.com$/, /^ns\d{4}\.hostgator\.com$/],
    link: null,
    open: "DNS",
    add: "+ ADD RECORD",
    save: "ADD",
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: null,
    traps: [],
  },
  "hostgator-br": {
    name: "HostGator Brasil",
    // Documented: dns3/4.hostgator.com.br for a registered domain with no plan yet. A plan's
    // names come in its activation email and are not on a page.
    ns: [/^dns[34]\.hostgator\.com\.br$/],
    link: null,
    open: "Editar Zona Avançada de DNS",
    add: "Adicionar registro",
    save: "Adicionar",
    // The value box's name changes with the type ("O nome é alterado conforme o Tipo").
    cname: { name: "Nome", value: null },
    txt: { name: "Nome", value: null },
    root: null,
    traps: [],
  },
  siteground: {
    name: "SiteGround",
    // Documented: ns1/2.siteground.net.
    ns: [/^ns[12]\.siteground\.net$/],
    link: null,
    open: "DNS Zone Editor",
    add: null,
    save: "Create",
    cname: { name: "Name", value: null },
    txt: { name: "Name", value: null },
    root: null,
    traps: [SHORT],
  },
  "registro-br": {
    name: "Registro.br",
    // Observed: a.auto.dns.br and b.auto.dns.br.
    ns: [/^[ab]\.auto\.dns\.br$/],
    link: null,
    open: "CONFIGURAR ZONA DNS",
    add: null,
    save: null,
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: null,
    traps: [{ kind: "advancedMode", mode: "Modo Avançado" }],
  },
  locaweb: {
    name: "Locaweb",
    // Documented: ns1-3.locaweb.com.br.
    ns: [/^ns[1-3]\.locaweb\.com\.br$/],
    link: null,
    open: "Editar zona DNS",
    add: "Adicionar entrada",
    save: null,
    cname: { name: "Entrada", value: "Conteúdo" },
    txt: { name: "Entrada", value: "Conteúdo" },
    // "o campo Entrada é preenchido por padrão com apenas um ponto (.)".
    root: ".",
    traps: [],
  },
  kinghost: {
    name: "KingHost",
    // Documented: dns1-6.kinghost.com.br.
    ns: [/^dns[1-6]\.kinghost\.com\.br$/],
    link: null,
    open: "Gerenciar DNS",
    add: "+ ADICIONAR DNS",
    save: "ADICIONAR DNS",
    // The form is a screenshot, so the case of "host" and "destino" is unconfirmed.
    cname: NO_FIELDS,
    txt: NO_FIELDS,
    root: "@",
    traps: [{ kind: "secondSave", button: "SALVAR ALTERAÇÕES" }],
  },
  "uol-host": {
    name: "UOL Host",
    // Documented: ns1-3.dominios.uol.com.br.
    ns: [/^ns[1-3]\.dominios\.uol\.com\.br$/],
    link: null,
    open: "Administrar DNS",
    add: "Criar nova entrada",
    save: "Salvar entrada",
    cname: { name: "Entrada", value: "Destino" },
    txt: { name: "Entrada", value: "Valor" },
    root: "",
    traps: [],
  },
  umbler: {
    name: "Umbler",
    // Documented: ns<NNN>.umbler.{com,in,com.br,co.uk}.
    ns: [/^ns\d{3}\.umbler\.(com|in|com\.br|co\.uk)$/],
    link: null,
    open: "Editor de DNS",
    add: "Adicionar",
    save: "Salvar",
    cname: { name: "Nome", value: "Endereço" },
    txt: { name: "Nome", value: "Dados" },
    root: "@",
    traps: [SHORT],
  },
  dnsimple: {
    name: "DNSimple",
    // Documented: ns1-4.dnsimple-edge.{com,net,io,org}, and the legacy ns1-4.dnsimple.com.
    ns: [/^ns[1-4]\.dnsimple-edge\.(com|net|io|org)$/, /^ns[1-4]\.dnsimple\.com$/],
    link: null,
    open: "Record editor",
    add: "Add record",
    save: "Add Record",
    cname: { name: "Name", value: "Content" },
    txt: { name: "Name", value: "Content" },
    root: "",
    traps: [SHORT],
  },
};

/** The first trap of a kind a host has. */
export function trapOf<K extends DnsTrapKind>(
  host: DnsHost,
  kind: K,
): Extract<DnsTrap, { kind: K }> | undefined {
  return host.traps.find((trap): trap is Extract<DnsTrap, { kind: K }> => trap.kind === kind);
}

/**
 * The hosts a zone's name servers point at. A host fits when every name matches one of its
 * patterns, so a set that mixes two hosts, or holds one name nobody claims, fits none. Names that
 * several hosts share answer with all of them, in `DNS_HOST_IDS` order: the app shows the
 * choice and never guesses. An empty list is a host we don't know.
 */
export function detectDnsHosts(nameservers: readonly string[]): DnsHostId[] {
  const names = nameservers.map(normalizeDnsName).filter(Boolean);
  if (!names.length) return [];
  return DNS_HOST_IDS.filter((id) =>
    names.every((name) => DNS_HOSTS[id].ns.some((pattern) => pattern.test(name))),
  );
}

/** The zone whose name servers answered: the nearest name at or above the hostname that has NS
 *  records of its own. Records are added in this zone, named relative to it. */
export interface DnsZone {
  zone: string;
  /** The zone's name servers, lowercase, without the trailing dot, sorted. */
  nameservers: string[];
}

/**
 * What we read from DNS about where a domain's records are edited. `hosts` says what the names
 * mean:
 * - one id: a host we know;
 * - several: the names fit more than one (Netlify and older Squarespace zones share NS1's
 *   names, Google Cloud DNS and Squarespace domains moved from Google Domains share Google's),
 *   so we do not guess;
 * - none: names no host we know uses, or a mix of hosts. Show the names and ask.
 */
export interface DnsHostReading extends DnsZone {
  hosts: DnsHostId[];
}
