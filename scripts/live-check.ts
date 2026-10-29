// Live check of one token writer against a real zone, with your own token. Run from the package
// folder:
//   HOST=cloudflare|digitalocean ZONE=example.com TOKEN=... bun scripts/live-check.ts
// Use a zone you can spare and a token limited to it (for Cloudflare: Zone:Read and DNS:Edit on
// that one zone; for DigitalOcean: domain read, create and delete). It writes only under
// `_ocd-test-<random>.<zone>` and `_ocd-txt-<random>.<zone>`, then deletes what it made through the
// host's own API. A zone whose name servers are elsewhere is the safest to use.
import { writers } from "../src/writers/index.ts";
import type { DnsHostId } from "../src/index.ts";

const host = process.env.HOST as DnsHostId;
const zone = process.env.ZONE ?? "";
const token = process.env.TOKEN ?? "";
const writer = writers[host];
if (!writer || !zone || !token) throw new Error("set HOST, ZONE and TOKEN");

const rand = Math.random().toString(36).slice(2, 8);
const cnameName = `_ocd-test-${rand}.${zone}`;
const txtName = `_ocd-txt-${rand}.${zone}`;
const target = `ocd-test-${rand}.example.net`;
const text = `ocd-live-test=${rand}`;

const results: string[] = [];
async function step(label: string, run: () => Promise<unknown>, expect: string) {
  let got: string;
  try {
    got = String(await run());
  } catch (error) {
    const e = error as { code?: string; message?: string };
    got = `throws ${e.code ?? "?"}`;
  }
  const ok = got === expect;
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, expected ${expect}`);
}

const cname = { type: "CNAME", name: cnameName, value: target } as const;
const txt = { type: "TXT", name: txtName, value: text } as const;

await step(
  "CNAME on a free name",
  () => writer.addRecord({ token, record: cname, comment: "one-click-dns live test" }),
  "created",
);
await step("same CNAME again", () => writer.addRecord({ token, record: cname }), "unchanged");
await step(
  "TXT on a free name",
  () => writer.addRecord({ token, record: txt, comment: "one-click-dns live test" }),
  "created",
);
await step(
  "same TXT again (quote handling)",
  () => writer.addRecord({ token, record: txt }),
  "unchanged",
);
await step(
  "TXT where a CNAME is",
  () => writer.addRecord({ token, record: { ...txt, name: cnameName } }),
  "throws conflict",
);
await step(
  "CNAME where a TXT is",
  () => writer.addRecord({ token, record: { ...cname, name: txtName } }),
  "throws conflict",
);
await step(
  "a bad token",
  () => writer.addRecord({ token: token.slice(0, -3) + "xyz", record: cname }),
  "throws token_invalid",
);

// Cleanup through the host's own API, for the two names only.
interface ApiAnswer {
  status: number;
  json: { result?: { id: string }[]; domain_records?: { id: number }[] } | null;
}
async function api(url: string, init: RequestInit = {}): Promise<ApiAnswer> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as ApiAnswer["json"] };
}
let deleted = 0;
if (host === "cloudflare") {
  const zones = await api(`https://api.cloudflare.com/client/v4/zones?name=${zone}`);
  const id = zones.json?.result?.[0]?.id;
  for (const name of [cnameName, txtName]) {
    const list = await api(
      `https://api.cloudflare.com/client/v4/zones/${id}/dns_records?name=${name}`,
    );
    for (const record of list.json?.result ?? []) {
      const del = await api(
        `https://api.cloudflare.com/client/v4/zones/${id}/dns_records/${record.id}`,
        {
          method: "DELETE",
        },
      );
      if (del.status === 200) deleted++;
    }
  }
} else if (host === "digitalocean") {
  for (const name of [cnameName, txtName]) {
    const list = await api(`https://api.digitalocean.com/v2/domains/${zone}/records?name=${name}`);
    for (const record of list.json?.domain_records ?? []) {
      const del = await api(
        `https://api.digitalocean.com/v2/domains/${zone}/records/${record.id}`,
        {
          method: "DELETE",
        },
      );
      if (del.status === 204) deleted++;
    }
  }
}
results.push(`cleanup: deleted ${deleted} record(s) (2 expected)`);
console.log(results.join("\n"));
