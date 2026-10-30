# @gusnips/one-click-dns

Put DNS records in a customer's zone. The package finds where their DNS lives, then gives you the best way to add the record: a signed Domain Connect link, a pasted API token, or the steps for that host.

```bash
npm install @gusnips/one-click-dns
# or
bun add @gusnips/one-click-dns
```

It has three entry points:

- `@gusnips/one-click-dns`: runs in the browser. The host list, the record spelling and the template presets.
- `@gusnips/one-click-dns/server`: reads DNS, builds signed links. Node or Bun.
- `@gusnips/one-click-dns/writers`: writes a record with an API token. Server only.

Keep keys and tokens on the server. Nothing in the browser entry needs them.

## First call

```ts
import { planConnection, systemDnsLookups } from "@gusnips/one-click-dns/server";

const plan = await planConnection({ hostname: "help.acme.com" }, systemDnsLookups(2000));

console.log(plan.reading?.hosts); // ["cloudflare"]
console.log(plan.methods.map((method) => method.kind)); // ["api-token", "manual"]
```

`methods` lists the ways to connect, best first:

| `kind`           | What it means                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `domain-connect` | One click. You send the person to `url`, their DNS host asks them to approve, and the records appear. |
| `api-token`      | The person pastes a token, and your server writes the record.                                         |
| `manual`         | The person copies the records by hand. The host's name is in `hosts`. Always the last one.            |

`plan.reading` is `null` when DNS did not answer. That is not the same as "host unknown", so do not show it as one.

## Add a record with a token

```ts
import { cloudflare } from "@gusnips/one-click-dns/writers";

const outcome = await cloudflare.addRecord({
  token, // the person's Cloudflare API token
  record: { type: "CNAME", name: "help.acme.com", value: "abc123.domains.example.app" },
});
// "created", "unchanged" or "unproxied"
```

The token is used for this call only. It is never stored, logged or put in an error. A record the person already has is never overwritten: you get a `conflict` instead.

When the write fails, it throws a `DnsWriteError` with a `code`. Word each code in your own languages:

| `code`              | What to tell the person                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `token_invalid`     | The host did not accept the token. Paste it again.                                   |
| `zone_read_missing` | The token cannot list domains. Give it that permission.                              |
| `dns_edit_missing`  | The token cannot change DNS records. Give it that permission.                        |
| `zone_not_found`    | The token's account does not hold this domain.                                       |
| `conflict`          | The name already has another record (`params.type`). They decide what to do with it. |
| `unavailable`       | The host did not answer. Try again.                                                  |

Four hosts have a writer today. What the person pastes is different for each. The tests use a fake network. Cloudflare and DigitalOcean were also run against a real account, with made-up underscore names that were deleted after. Porkbun and Name.com were not:

| Writer         | `token` is              | What it needs                                                           | How far it is checked                                                                     |
| -------------- | ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cloudflare`   | An API token            | `Zone:Read` and `DNS:Edit`                                              | Run against a real zone on 2026-10-29: create, repeat, TXT, conflicts and a wrong token   |
| `porkbun`      | `apikey:secretapikey`   | "API access" turned on for the domain in Porkbun (it is off by default) | Written from the host's API spec. Never run against a real account                        |
| `digitalocean` | A personal access token | `domain:read` and `domain:create`, or full access                       | Run against a real domain on 2026-10-29: create, repeat, TXT, conflicts and a wrong token |
| `name-com`     | `username:apitoken`     | API access turned on in Account Settings, Security                      | Written from the host's docs. Never run against a real account                            |

`writers` maps a host id to its writer, so `writers[host]` is `undefined` for a host with no writer.

### Check a writer against your own account

The repository has a script that tries a writer on a real zone and removes what it made. Use a spare zone and a token limited to it:

```bash
HOST=cloudflare ZONE=example.com TOKEN=your-token bun run live
```

It writes a CNAME and a TXT record under made-up underscore names, runs each a second time (both must read as "unchanged"), checks that a clashing record is refused and that a wrong token is reported as one, then deletes its records. Cloudflare and DigitalOcean are supported.

## One-click links (Domain Connect)

A link needs a template that your DNS host has switched on, and a key pair. You publish the public key in DNS and keep the private key on your server.

```ts
const plan = await planConnection(
  {
    hostname: "help.acme.com",
    connect: {
      providerId: "example.com", // your id in the Templates repository
      keyId: "_dck1", // the TXT record name that holds your public key
      serviceId: "custom-domain", // your template
      privateKeyPem,
      params: (zone) => ({
        domain: zone,
        host: "help",
        target: "abc123",
        redirect_uri: "https://app.example.com/done",
      }),
    },
  },
  systemDnsLookups(2000),
);
```

When the host has your template, `plan.methods` starts with a `domain-connect` method. Sending the person back to `redirect_uri` proves nothing. Check the DNS yourself before you mark the domain done.

Only these providers are asked, because their `_domainconnect` value and settings were read from DNS: Cloudflare, Vercel, Simply.com and GoDaddy. A name in a customer's DNS is never fetched. More providers join the same way, one value at a time.

A provider listed here is one the package can talk to. It is not a promise that the provider will switch your template on. GoDaddy, for one, told us on 2026-10-29 that it is not accepting new templates for direct onboarding and gave no date. Ask each provider, and use `templateCoverage` to see who said yes. Where there is no link, `plan.methods` still ends with the steps for that host.

### Which providers have switched your template on

A merged template is not a template a provider uses. Each provider turns templates on by hand, and the only way to know is to ask it. `templateCoverage` asks every provider in the list once:

```ts
import { templateCoverage } from "@gusnips/one-click-dns/server";

const coverage = await templateCoverage(
  {},
  { providerId: "example.com", serviceId: "custom-domain" },
);
// { cloudflare: "not_supported", godaddy: "supported", vercel: "not_supported", simply: "not_supported" }
```

`"unanswered"` means the provider was busy or did not reply. It never means no. Run it now and then to see when a provider starts to support your template.

## Templates

A template is a small JSON file in the public [Domain Connect Templates](https://github.com/Domain-Connect/Templates) repository. It lists the records you may ask a host to add. The presets build one that follows the repository's rules:

```ts
import { cnameTemplate, templateFileName } from "@gusnips/one-click-dns";

const template = cnameTemplate(
  {
    providerId: "example.com",
    providerName: "Example",
    logoUrl: "https://example.com/logo.svg",
    syncPubKeyDomain: "example.com",
    syncRedirectDomain: "app.example.com",
  },
  { pointsTo: "%target%.domains.example.com" },
);

console.log(templateFileName(template)); // "example.com.custom-domain.json"
```

There are presets for a CNAME, DMARC, SPF, DKIM, MX and a verification TXT.

Two of them change how a domain's email works. The MX preset replaces the MX records the domain has, so its mail goes somewhere else. The SPF preset adds a sender to the domain's SPF record. Ask the person for consent in your own screen before you offer either link, and say what changes in the template's `description`, which the DNS host shows when they approve.

A template belongs to the company that files it. It names your key domain, and the host checks every link against the key published there. So you cannot use someone else's template, and nobody can use yours. The customer's domain is not in the template: it comes with each link, so one template serves every customer.

To file a template: test it in the [online editor](https://domainconnect.paulonet.eu/dc/free/templateedit), run `dc-template-linter -merge-or-fail` on it, open a pull request, then ask each DNS host to switch it on.

### Keep separate SPF services

Two links for the same template can replace each other's records, even if you check DNS before issuing either link. For SPF, that can remove another service's permission to send.

When one template serves several sending services, opt in to separate instances:

```ts
const template = spfTemplate(identity, { multiInstance: true, version: 2 });
```

File the updated template and wait for the DNS provider to switch it on. Before signing a link, require that provider's copy to advertise the flag:

```ts
import { discoverConnect, systemDnsLookups } from "@gusnips/one-click-dns/server";

const discovery = await discoverConnect(
  { txt: systemDnsLookups(2000).txt },
  {
    zone: "acme.com",
    providerId: "example.com",
    serviceId: "spf",
    budgetMs: 2000,
    requireMultiInstance: true,
  },
);
```

This check needs both a provider entry with `supportsMultiInstance: true` and the literal template flag `multiInstance: true`. Missing or false support returns `not_offered`. The template check reads the same size-limited response and makes no extra request. Other discovery calls keep their current behavior.

No built-in provider has verified instance support yet. [Cloudflare says it ignores this flag](https://developers.cloudflare.com/dns/reference/domain-connect/#template-definition); the other providers are unverified. Requiring instances therefore returns `not_offered` for each built-in provider. Keep a manual fallback. For a custom `providers` list, set `supportsMultiInstance: true` only after verifying that provider's behavior, not just its template JSON.

Only sign when `discovery.found` is true. Pass a stable `instanceId` in `signedApplyUrl`'s `params`: derive it from the full sending domain and the service's SPF include. Repeated links for the same pair use the same id; different domains or services use different ids. The package does not choose that id for you. The flag does not check SPF's lookup limit or make a redirect back to your app proof that DNS changed.

## Steps for the host

`DNS_HOSTS` holds 33 hosts: how to recognise them from their name servers, the labels on their DNS page and the traps (a proxy on by default, a trailing dot, a TXT that needs quotes). The package holds data and no sentences, so you write the steps in your own words and languages. `dnsRecordRow` spells a record the way a host wants it typed:

```ts
import { dnsRecordRow } from "@gusnips/one-click-dns";

dnsRecordRow("route53", "acme.com", { type: "TXT", name: "acme.com", value: "v=spf1 ~all" });
// { type: "TXT", name: "", value: "\"v=spf1 ~all\"", atRoot: true, rootUnsure: false }
```

A name server pattern is in the list only when the host documents it or it was seen in DNS. A label is quoted only when the host's own page shows it.

## Checks

```bash
bun run lint
bun run typecheck
bun run build
bun test src/path/to/file.test.ts
```
