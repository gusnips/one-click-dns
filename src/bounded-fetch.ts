// One bounded HTTP request, for a host we chose (never a name read from a customer's DNS): no
// redirect followed (a 3xx comes back as the answer it is, with no body, because a URL can carry
// a key a redirect would carry elsewhere), one timer that covers the connect, the status and the
// body, and a body read no further than its bound. Anything else that goes wrong is `null`: the
// caller never needs to tell a refused connection from a slow one, and an error from `fetch` can
// quote the URL, so none is kept or rethrown.
import { readBounded } from "@gusnips/server";

/** What the package needs from `fetch`: a function from a URL and options to a response. The
 *  global `fetch` is one, and so is a test's fake, with no cast. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface BoundedAnswer {
  status: number;
  text: string;
}

export async function fetchBounded(
  doFetch: FetchFn,
  url: string,
  init: RequestInit,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<BoundedAnswer | null> {
  const signal = AbortSignal.timeout(limits.timeoutMs);
  // The real `fetch` stops when the signal fires. A wrapper or a fake might not, so the same
  // timer also ends the wait here: the bound holds whatever `doFetch` does with the signal.
  const outOfTime = new Promise<null>((resolve) => {
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  const attempt = async (): Promise<BoundedAnswer | null> => {
    try {
      const res = await doFetch(url, { ...init, redirect: "manual", signal });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel().catch(() => undefined);
        // An answer, and not one we use: the status stays, the body is never read.
        return { status: res.status || 302, text: "" };
      }
      const { bytes, truncated } = await readBounded(res.body, limits.maxBytes);
      if (truncated) return null;
      return { status: res.status, text: new TextDecoder().decode(bytes) };
    } catch {
      return null;
    }
  };
  return Promise.race([attempt(), outOfTime]);
}
