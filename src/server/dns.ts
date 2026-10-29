// The system resolver, bounded: the one place this package asks DNS in-process, so "nothing is
// there" and "DNS did not answer" mean the same thing in every read.
import { Resolver } from "node:dns/promises";

/** What one question came back with. `absent` is DNS answering that nothing is there; `failed`
 *  is DNS not answering, which must never read as absent. */
export type DnsAnswer<T> = T | "absent" | "failed";

/** Resolver codes that mean "nothing is there". Node answers ENODATA for a name with no
 *  record of the kind asked and ENOTFOUND for a name that does not exist; Bun answers
 *  ENOTFOUND for both. Every other code (a timeout, SERVFAIL, a refused query) is DNS not
 *  answering. */
const ABSENT_CODES = new Set(["ENOTFOUND", "ENODATA"]);

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

/** Ask one question of a Resolver the caller does not own. */
export type DnsAsk = <T>(question: (resolver: Resolver) => Promise<T>) => Promise<DnsAnswer<T>>;

/**
 * A Resolver of its own (one try per question), and the way to ask it: each question is bounded
 * by `timeoutMs` whatever the runtime's own resolver does with its timeout option (Node waits
 * up to twice as long). The bound gives up on a question; it does not cancel it, which is why
 * this Resolver is never shared with a caller that needs `cancel()`.
 */
export function systemResolver(timeoutMs: number): DnsAsk {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  return async (question) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        question(resolver),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("DNS lookup timed out"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      return ABSENT_CODES.has(errorCode(error)) ? "absent" : "failed";
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The questions the package asks: the TXT records of a name, one CNAME hop, a name's NS. */
export interface DnsLookups {
  txt(name: string): Promise<DnsAnswer<{ txts: string[] }>>;
  cname(name: string): Promise<DnsAnswer<{ name: string }>>;
  ns(name: string): Promise<DnsAnswer<{ names: string[] }>>;
}

/** The system resolver, each question bounded by `timeoutMs`. */
export function systemDnsLookups(timeoutMs: number): DnsLookups {
  const ask = systemResolver(timeoutMs);
  return {
    async txt(name) {
      const answer = await ask((resolver) => resolver.resolveTxt(name));
      // A TXT value split in several strings is one value.
      return typeof answer === "string" ? answer : { txts: answer.map((parts) => parts.join("")) };
    },
    async cname(name) {
      const answer = await ask((resolver) => resolver.resolveCname(name));
      if (typeof answer === "string") return answer;
      // A name holds one CNAME at most; an empty answer is none.
      const first = answer[0];
      return first ? { name: first } : "absent";
    },
    async ns(name) {
      const answer = await ask((resolver) => resolver.resolveNs(name));
      return typeof answer === "string" ? answer : { names: answer };
    },
  };
}
