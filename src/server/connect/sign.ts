// The signed link that sends a person to their DNS provider's own page, where they approve one
// of our templates (Domain Connect's synchronous flow).
//
// The bytes are the reference library's (github.com/Domain-Connect/domainconnect_python,
// `get_domain_connect_template_sync_url` and `_generate_sig`): the parameters sorted by name,
// each pair percent-encoded and joined with `&` is the query string, and that string (no `?`,
// no `sig`, no `key`) is what is signed, RSASSA-PKCS1-v1_5 with SHA-256, in standard base64,
// percent-encoded again when it is appended. The library appends `sig` and then `key`; Cloudflare
// requires the signature to be the LAST parameter, and the spec's rule ("everything after the ?,
// except the sig and key values") holds either way, so we append `key` and then `sig`.
// sign.test.ts checks the convention against the signature the library publishes.
//
// Server only: nothing but `node:crypto`, and the private key never leaves it.
import { createPrivateKey, sign } from "node:crypto";

/** Who is asking, as the templates name it. */
export interface DomainConnectIdentity {
  /** The provider id our templates are filed under in the Templates repository
   *  (`<providerId>.<serviceId>.json`). Use a domain that will not be renamed. */
  providerId: string;
  /** The label of the TXT record that holds our public key (`_dck1`), the template's
   *  `syncPubKeyDomain` hosts it. A new key is a new id and a release. */
  keyId: string;
}

/** Python's `quote_plus`, which the library encodes with: `encodeURIComponent` leaves
 *  `! ' ( ) *` alone and writes a space as `%20`, where `quote_plus` escapes the five and writes
 *  `+`. The bytes match whatever comes. */
const encode = (value: string) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");

/**
 * The page to send the person to: `syncUrl` is the provider's `urlSyncUX`, `params` the
 * template's own (`domain`, `host`, its variables) and `redirect_uri`. Signed with the private
 * key (a PEM), whose public half is the TXT record `keyId` names. `key` and `sig` always come
 * last, in that order.
 */
export function signedApplyUrl(
  args: DomainConnectIdentity & {
    syncUrl: string;
    serviceId: string;
    params: Readonly<Record<string, string>>;
    privateKeyPem: string;
  },
): string {
  const query = Object.entries(args.params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join("&");
  const signature = sign(
    "sha256",
    Buffer.from(query, "utf8"),
    createPrivateKey(args.privateKeyPem),
  ).toString("base64");
  const path = `/v2/domainTemplates/providers/${args.providerId}/services/${args.serviceId}/apply`;
  return `${args.syncUrl}${path}?${query}&key=${args.keyId}&sig=${encode(signature)}`;
}
