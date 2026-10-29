import type { DnsHostId } from "../hosts.ts";
import { cloudflare } from "./cloudflare.ts";
import { digitalocean } from "./digitalocean.ts";
import { namecom } from "./namecom.ts";
import { porkbun } from "./porkbun.ts";
import type { DnsWriter } from "./types.ts";

export type { FetchFn } from "../bounded-fetch.ts";
export { cloudflare, digitalocean, namecom, porkbun };
export {
  DnsWriteError,
  type DnsWriteErrorCode,
  type DnsWriteOutcome,
  type DnsWriteRecord,
  type DnsWriter,
} from "./types.ts";

/** The hosts that take a pasted token, by host id: `writers[host]` is undefined for the rest. */
export const writers: Partial<Record<DnsHostId, DnsWriter>> = {
  cloudflare,
  digitalocean,
  "name-com": namecom,
  porkbun,
};
