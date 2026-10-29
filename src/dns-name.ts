/** Trim a DNS name, lowercase it and remove one trailing ASCII dot.
 *  This does not validate the name or convert international names to ASCII. */
export function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}
