export {
  DNS_HOSTS,
  DNS_HOST_IDS,
  detectDnsHosts,
  trapOf,
  type DnsFields,
  type DnsHost,
  type DnsHostId,
  type DnsHostReading,
  type DnsTrap,
  type DnsTrapKind,
  type DnsZone,
} from "./hosts.ts";
export {
  dnsRecordRow,
  recordNameInZone,
  relativeName,
  type DnsRecordRow,
  type DnsRecordSpec,
} from "./records.ts";
export { normalizeDnsName } from "./dns-name.ts";
export {
  cnameTemplate,
  dkimTemplate,
  dmarcTemplate,
  mxTemplate,
  spfTemplate,
  templateFileName,
  verificationTemplate,
  type DomainConnectTemplate,
  type TemplateIdentity,
  type TemplateRecord,
} from "./templates.ts";
