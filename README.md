# @gusnips/one-click-dns

Put DNS records in a customer's zone. It finds where their DNS lives, then gives you the best way to add the record: a signed Domain Connect link, a pasted API token, or the steps for that host.

```bash
npm install @gusnips/one-click-dns
# or
bun add @gusnips/one-click-dns
```

## First call

```ts
import { planConnection, systemDnsLookups } from "@gusnips/one-click-dns/server";

const plan = await planConnection({ hostname: "help.acme.com" }, systemDnsLookups(2000));

console.log(plan.reading?.hosts); // ["cloudflare"]
console.log(plan.methods.map((method) => method.kind)); // ["api-token", "manual"]
```

`methods` is the list of ways to connect, best first. It always ends with `manual`, so a person is never left without one.

Work in progress. See `src/` for what exists today.
