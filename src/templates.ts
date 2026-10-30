// Ready-made Domain Connect templates, so an app picks one instead of writing the JSON. Each
// preset takes the app's own identity and returns a template that follows the Templates
// repository's rules: `syncPubKeyDomain` always set, SPF as `SPFM` (never a TXT), unique TXT
// records with a conflict mode, `essential: "OnApply"` on the records a person may edit later
// (DMARC), fixed parts in `host`.
//
// A template is tied to its owner: it names the owner's key domain, and a provider checks every
// link against the public key published there. So a preset gives you the shape, not a shared
// template: file the result under your own provider id, and sign with your own key. The
// customer's domain is never in a template; it arrives with each link.
//
// Browser-safe: plain objects. File each one as `templateFileName(template)` in
// github.com/Domain-Connect/Templates, test it in the online editor, and lint it with
// `dc-template-linter -merge-or-fail`.

/** Who owns the templates. */
export interface TemplateIdentity {
  /** A domain that will not be renamed (`getcolding.com`). Part of every file name. */
  providerId: string;
  /** The brand a person sees (`colding`). */
  providerName: string;
  logoUrl: string;
  /** The domain whose DNS holds the public key (`_dck1.<syncPubKeyDomain>`). */
  syncPubKeyDomain: string;
  /** Where `redirect_uri` may point; a comma separates several. */
  syncRedirectDomain: string;
}

export interface TemplateRecord {
  type: "CNAME" | "TXT" | "MX" | "SPFM";
  /** The label inside the customer's name; `@` is the name itself. */
  host: string;
  pointsTo?: string;
  data?: string;
  priority?: number;
  spfRules?: string;
  ttl?: number;
  essential?: "OnApply";
  txtConflictMatchingMode?: "All" | "Prefix";
  txtConflictMatchingPrefix?: string;
}

export interface DomainConnectTemplate extends TemplateIdentity {
  serviceId: string;
  serviceName: string;
  version: number;
  description: string;
  variableDescription?: string;
  /** The subdomain is required: the template has no meaning at the name itself. */
  hostRequired?: boolean;
  /** Keep applications with different instanceId values separate. */
  multiInstance?: boolean;
  records: TemplateRecord[];
}

/** What every preset lets the app choose. */
interface Wording {
  serviceId?: string;
  serviceName?: string;
  description?: string;
  version?: number;
  multiInstance?: boolean;
}

const TTL = 3600;

function template(
  identity: TemplateIdentity,
  serviceId: string,
  fallback: { serviceName: string; description: string; variableDescription?: string },
  wording: Wording,
  records: TemplateRecord[],
  hostRequired?: boolean,
): DomainConnectTemplate {
  return {
    providerId: identity.providerId,
    providerName: identity.providerName,
    serviceId: wording.serviceId ?? serviceId,
    serviceName: wording.serviceName ?? fallback.serviceName,
    version: wording.version ?? 1,
    logoUrl: identity.logoUrl,
    description: wording.description ?? fallback.description,
    ...(fallback.variableDescription ? { variableDescription: fallback.variableDescription } : {}),
    syncPubKeyDomain: identity.syncPubKeyDomain,
    syncRedirectDomain: identity.syncRedirectDomain,
    ...(hostRequired ? { hostRequired } : {}),
    ...(wording.multiInstance !== undefined ? { multiInstance: wording.multiInstance } : {}),
    records,
  };
}

/** The `<providerId>.<serviceId>.json` name the Templates repository files it under. */
export function templateFileName(
  t: Pick<DomainConnectTemplate, "providerId" | "serviceId">,
): string {
  return `${t.providerId}.${t.serviceId}.json`.toLowerCase();
}

/**
 * A subdomain that points at you: a custom domain, a tracking host, a help center. The
 * subdomain is the link's `host`; `pointsTo` may hold a variable (`%target%.cname.example.com`).
 */
export function cnameTemplate(
  identity: TemplateIdentity,
  options: Wording & { pointsTo: string; variableDescription?: string },
): DomainConnectTemplate {
  return template(
    identity,
    options.serviceId ?? "custom-domain",
    {
      serviceName: "Connect a custom domain",
      description: "Points your subdomain at us. The subdomain is the host parameter.",
      variableDescription: options.variableDescription,
    },
    options,
    [{ type: "CNAME", host: "@", pointsTo: options.pointsTo, ttl: TTL }],
    true,
  );
}

/**
 * A DMARC record that only watches (`p=none`) and rejects nothing; a stricter policy is the
 * domain owner's call. With `rua`, the link carries the address that gets the reports.
 */
export function dmarcTemplate(
  identity: TemplateIdentity,
  options: Wording & { rua?: boolean } = {},
): DomainConnectTemplate {
  return template(
    identity,
    "dmarc",
    {
      serviceName: "DMARC record for your sending domain",
      description:
        "Adds a DMARC record that only monitors (p=none), so mailbox providers can see that your sending domain has a policy. It rejects and quarantines nothing.",
      variableDescription: options.rua
        ? "%dmarcRua%: the email address that gets the DMARC aggregate reports."
        : undefined,
    },
    options,
    [
      {
        type: "TXT",
        host: "_dmarc",
        data: options.rua ? "v=DMARC1; p=none; rua=mailto:%dmarcRua%" : "v=DMARC1; p=none",
        ttl: TTL,
        txtConflictMatchingMode: "Prefix",
        txtConflictMatchingPrefix: "v=DMARC1",
        essential: "OnApply",
      },
    ],
  );
}

/** Adds one `include:` to the domain's SPF record. `SPFM` merges it into the one record the
 *  name may have; a TXT would make a second one and break SPF. The link carries `%include%`. */
export function spfTemplate(
  identity: TemplateIdentity,
  options: Wording = {},
): DomainConnectTemplate {
  return template(
    identity,
    "spf",
    {
      serviceName: "Allow us to send email for your domain",
      description:
        "Adds our sending service to your domain's SPF record, next to what is already there.",
      variableDescription: "%include%: the domain to include, such as _spf.example.com.",
    },
    options,
    [{ type: "SPFM", host: "@", spfRules: "include:%include%" }],
  );
}

/**
 * DKIM as CNAMEs, for services that publish the key on their side.
 *
 * By default the link carries `%selector1%` and `%target1%`, then the same pair numbered up to
 * `keys`. When your key names never change, fix them: `selectors: ["cd1", "cd2"]` writes
 * `cd1._domainkey` and `cd2._domainkey` into the template, which the repository prefers to a
 * variable. `pointsTo` then names where each CNAME goes (`(n) => "%dkim" + n + "%.example.net"`),
 * and `variableDescription` says what its variables mean.
 */
export function dkimTemplate(
  identity: TemplateIdentity,
  options: Wording & {
    keys?: number;
    selectors?: readonly string[];
    pointsTo?: (n: number) => string;
    variableDescription?: string;
  } = {},
): DomainConnectTemplate {
  const { selectors } = options;
  const keys = selectors?.length ?? options.keys ?? 2;
  const numbers = Array.from({ length: keys }, (_, index) => index + 1);
  const hostOf = (n: number) =>
    selectors ? `${selectors[n - 1]}._domainkey` : `%selector${n}%._domainkey`;
  const describe = (n: number) =>
    selectors
      ? `%target${n}%: where ${selectors[n - 1]}._domainkey points`
      : `%selector${n}%: the key name, ${n} of ${keys}; %target${n}%: where it points`;
  return template(
    identity,
    "dkim",
    {
      serviceName: "Sign your email with our key",
      description: "Adds the CNAME records that let us sign email sent from your domain.",
      variableDescription: options.variableDescription ?? numbers.map(describe).join("; "),
    },
    options,
    numbers.map((n) => ({
      type: "CNAME" as const,
      host: hostOf(n),
      pointsTo: options.pointsTo?.(n) ?? `%target${n}%`,
      ttl: TTL,
    })),
  );
}

/** The MX record that sends the domain's mail to you. It changes where the domain's email is
 *  delivered and replaces the MX records it has, so ask the person for consent before you offer
 *  the link; say so in `description` too. */
export function mxTemplate(
  identity: TemplateIdentity,
  options: Wording & { pointsTo: string; priority?: number },
): DomainConnectTemplate {
  return template(
    identity,
    "mx",
    {
      serviceName: "Receive email for your domain with us",
      description: "Sends the email for your domain to our mail servers.",
    },
    options,
    [
      {
        type: "MX",
        host: "@",
        pointsTo: options.pointsTo,
        priority: options.priority ?? 10,
        ttl: TTL,
      },
    ],
  );
}

/** A TXT record that proves you own the domain: a fixed prefix and the token the link carries
 *  as `%value%`. Only one may sit at the name, so a new token replaces the old one. */
export function verificationTemplate(
  identity: TemplateIdentity,
  options: Wording & { prefix: string; host?: string },
): DomainConnectTemplate {
  return template(
    identity,
    "domain-verification",
    {
      serviceName: "Verify your domain",
      description: "Adds the record that shows us you own this domain.",
      variableDescription: "%value%: the verification token we gave you.",
    },
    options,
    [
      {
        type: "TXT",
        host: options.host ?? "@",
        data: `${options.prefix}%value%`,
        ttl: TTL,
        txtConflictMatchingMode: "Prefix",
        txtConflictMatchingPrefix: options.prefix,
        essential: "OnApply",
      },
    ],
  );
}
