// How to connect a domain, best way first. One call reads where the domain's DNS lives and lists
// what works for that host: a Domain Connect link (one click, signed), a pasted API token (the
// server writes the record), or the host's steps by hand. The app picks what to show; the last
// one is always there, so a person is never left without a way.
import { dnsHostOf, readDnsZone, type ZoneLookups } from "./zone.ts";
import { discoverConnect, type DiscoveryIo } from "./connect/discover.ts";
import { signedApplyUrl, type DomainConnectIdentity } from "./connect/sign.ts";
import { writers } from "../writers/index.ts";
import type { DnsHostId, DnsHostReading } from "../hosts.ts";

export type ConnectMethod =
  | {
      kind: "domain-connect";
      /** The provider's own name for itself: "Cloudflare". */
      provider: string;
      /** The signed page to send the person's browser to. */
      url: string;
    }
  | { kind: "api-token"; host: DnsHostId }
  | { kind: "manual"; hosts: DnsHostId[] };

export interface ConnectPlan {
  /** Where the domain's DNS lives; null when DNS didn't answer, never an empty reading. */
  reading: DnsHostReading | null;
  /** Best first. Ends with `manual`. */
  methods: ConnectMethod[];
  /** Domain Connect asked and got no answer in time: worth asking again. */
  connectUnanswered: boolean;
}

export interface PlanInput {
  hostname: string;
  /** Offer a Domain Connect link for one of the app's templates. Left out: none is offered. */
  connect?: DomainConnectIdentity & {
    serviceId: string;
    privateKeyPem: string;
    /** The template's parameters for this zone: `domain`, `host`, its variables and
     *  `redirect_uri`. The app owns them. */
    params: (zone: string) => Record<string, string>;
  };
  /** Time for the zone read, and the same again for Domain Connect. Default 3 000. */
  budgetMs?: number;
}

export async function planConnection(
  input: PlanInput,
  io: DiscoveryIo & ZoneLookups,
): Promise<ConnectPlan> {
  const budgetMs = input.budgetMs ?? 3_000;
  const zone = await readDnsZone(io, input.hostname, budgetMs);
  if (!zone)
    return { reading: null, methods: [{ kind: "manual", hosts: [] }], connectUnanswered: false };

  const reading = dnsHostOf(zone);
  const methods: ConnectMethod[] = [];
  let connectUnanswered = false;

  const { connect } = input;
  if (connect) {
    const found = await discoverConnect(io, {
      zone: zone.zone,
      providerId: connect.providerId,
      serviceId: connect.serviceId,
      budgetMs,
    });
    if (found.found)
      methods.push({
        kind: "domain-connect",
        provider: found.provider,
        url: signedApplyUrl({
          providerId: connect.providerId,
          keyId: connect.keyId,
          serviceId: connect.serviceId,
          privateKeyPem: connect.privateKeyPem,
          syncUrl: found.syncUrl,
          params: connect.params(zone.zone),
        }),
      });
    else connectUnanswered = found.reason === "unanswered";
  }

  // Only when the names say one host: several fit, and we don't guess where a token goes.
  const [only, ...others] = reading.hosts;
  if (only && !others.length && writers[only]) methods.push({ kind: "api-token", host: only });

  methods.push({ kind: "manual", hosts: reading.hosts });
  return { reading, methods, connectUnanswered };
}
