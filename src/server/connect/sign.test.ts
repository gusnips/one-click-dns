import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { beforeAll, describe, expect, it } from "bun:test";
import { signedApplyUrl } from "./sign.ts";

const ID = { providerId: "example.com", keyId: "_dck1" };
const SERVICES = { trackingDomain: "tracking-domain", dmarc: "dmarc" } as const;

/** The Domain Connect reference library's own published signature (domainconnect_python,
 *  `test_generate_sig_params`), checked with the example public key from the spec. Only a PUBLIC
 *  key is here: this pins the algorithm and the signed bytes (the sorted, encoded query string,
 *  with no `key` and no `sig`) against someone else's output. Our own tests sign with a key made
 *  for the run. */
const PUBLISHED = {
  spki: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA18SgvpmeasN4BHkkv0SBjAzIc4grYLjiAXRtNiBUiGUDMeTzQrKTsWvy9NuxU1dIHCZy9o1CrKNg5EzLIZLNyMfI6qiXnM+HMd4byp97zs/3D39Q8iR5poubQcRaGozWx8yQpG0OcVdmEVcTfyR/XSEWC5u16EBNvRnNAOAvZYUdWqVyQvXsjnxQot8KcK0QP8iHpoL/1dbdRy2opRPQ2FdZpovUgknybq/6FkeDtW7uCQ6Mvu4QxcUa3+WP9nYHKtgWip/eFxpeb+qLvcLHf1h0JXtxLVdyy6OLk3f2JRYUX2ZZVDvG3biTpeJz6iRzjGg6MfGxXZHjI8weDjXrJwIDAQAB",
  query: "domain=connect.domains&RANDOMTEXT=shm%3A1552462554%3AHola&IP=132.148.25.185",
  sig: "pDgKCqDX%2BYafD8fqchYjayZt6bgf5ncz%2FJlYVGV0SbZrcUPb5tgMyqpn4g%2BlY%2FigpgKYFhkXGcAeNOrQ0aiTu31bLo7ODkK2fWsdz4G%2BpSa5Lkb7NhwS07o6cpQMcvO8aihA7pU5%2BIbPd3Im1ncUNol3zfjeyAl%2BaBkfcXOAl2xnWY8NobMzaI0jqVwPnWperRj5VGfX6vu5mPviDFzcS0RvruRAHv08X8zDp%2BBvCnpk4L1cWn49%2FZceS8Hifo7%2FkVd4j%2BdFGvze7H4cGZ2Kx6ZrSShW3a7AwvV6cVGxqn%2FdQlpYYsHBHlv9Zbhe2pKuqpAhB%2FxDN2G%2FjQaDqmcWGw%3D%3D",
};

let privateKeyPem: string;
let publicKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = pair.publicKey;
});

const SYNC = "https://dash.cloudflare.com/domainconnect";

/** The URL split the way a provider reads it: the path, the query as signed, then key and sig. */
function parts(url: string) {
  const [path = "", query = ""] = url.split("?");
  const keyAt = query.indexOf("&key=");
  const signed = query.slice(0, keyAt);
  const tail = new URLSearchParams(query.slice(keyAt + 1));
  return { path, signed, tail, tailNames: [...tail.keys()] };
}

describe("the reference library's published signature", () => {
  it("verifies as RSASSA-PKCS1-v1_5 over SHA-256 of the query string, in standard base64", () => {
    const key = createPublicKey({
      key: Buffer.from(PUBLISHED.spki, "base64"),
      format: "der",
      type: "spki",
    });
    const sig = Buffer.from(decodeURIComponent(PUBLISHED.sig), "base64");
    expect(verify("sha256", Buffer.from(PUBLISHED.query), key, sig)).toBe(true);
    // One changed byte of what is signed is no longer the signature.
    expect(verify("sha256", Buffer.from(`${PUBLISHED.query}x`), key, sig)).toBe(false);
  });
});

describe("signedApplyUrl", () => {
  const params = {
    domain: "acme.io",
    host: "t",
    target: "a1b2c3d4e5f6",
    redirect_uri: "https://console.example.com/acme/settings?dnsConnect=7",
  };

  it("names our provider, the template, the apply path and the key id", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.trackingDomain,
      params,
      privateKeyPem,
    });
    expect(parts(url).path).toBe(
      `${SYNC}/v2/domainTemplates/providers/${ID.providerId}/services/tracking-domain/apply`,
    );
    expect(parts(url).tail.get("key")).toBe(ID.keyId);
  });

  it("sorts the parameters by name and percent-encodes every value", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.trackingDomain,
      params,
      privateKeyPem,
    });
    expect(parts(url).signed).toBe(
      "domain=acme.io&host=t&redirect_uri=https%3A%2F%2Fconsole.example.com%2Facme%2Fsettings%3FdnsConnect%3D7&target=a1b2c3d4e5f6",
    );
  });

  it("puts key and then sig last, because Cloudflare reads the signature as the final parameter", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.dmarc,
      params: { domain: "acme.io", redirect_uri: "https://console.example.com/" },
      privateKeyPem,
    });
    expect(parts(url).tailNames).toEqual(["key", "sig"]);
    expect(url.lastIndexOf("&sig=")).toBeGreaterThan(url.lastIndexOf("&key="));
  });

  it("signs exactly the query before key, and the public half verifies it", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.trackingDomain,
      params,
      privateKeyPem,
    });
    const { signed, tail } = parts(url);
    // URLSearchParams has already undone the percent-encoding of the standard base64.
    const sig = Buffer.from(tail.get("sig") ?? "", "base64");
    expect(sig).toHaveLength(256);
    expect(verify("sha256", Buffer.from(signed), publicKey, sig)).toBe(true);
    expect(verify("sha256", Buffer.from(`${signed}&host=evil`), publicKey, sig)).toBe(false);
  });

  it("does not verify under another key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.trackingDomain,
      params,
      privateKeyPem,
    });
    const { signed, tail } = parts(url);
    const sig = Buffer.from(tail.get("sig") ?? "", "base64");
    expect(verify("sha256", Buffer.from(signed), other, sig)).toBe(false);
  });

  it("escapes the five characters encodeURIComponent leaves, as Python's quote_plus does", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.trackingDomain,
      params: { domain: "acme.io", redirect_uri: "/a!b'c(d)e*f" },
      privateKeyPem,
    });
    expect(parts(url).signed).toBe("domain=acme.io&redirect_uri=%2Fa%21b%27c%28d%29e%2Af");
  });

  it("writes a space as a plus sign, as quote_plus does", () => {
    const url = signedApplyUrl({
      ...ID,
      syncUrl: SYNC,
      serviceId: SERVICES.dmarc,
      params: { domain: "acme.io", note: "a b" },
      privateKeyPem,
    });
    expect(parts(url).signed).toBe("domain=acme.io&note=a+b");
  });

  it("signs the same bytes the same way every time, so a reload is the same link", () => {
    const make = () =>
      signedApplyUrl({
        ...ID,
        syncUrl: SYNC,
        serviceId: SERVICES.trackingDomain,
        params,
        privateKeyPem,
      });
    expect(make()).toBe(make());
  });

  it("refuses a value that is not a key, with none of it in the error", () => {
    let message = "";
    try {
      signedApplyUrl({
        ...ID,
        syncUrl: SYNC,
        serviceId: SERVICES.dmarc,
        params: { domain: "acme.io" },
        privateKeyPem: "definitely-not-pem-secretvalue",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("secretvalue");
  });
});
