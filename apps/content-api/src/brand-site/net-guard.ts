import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guards against SSRF on the one endpoint that fetches a URL the user chose.
 *
 * Everything else in this service talks to hosts we picked. This does not, so
 * an unguarded fetch here is a request forgery primitive: `http://127.0.0.1:4000`
 * reaches our own API with no auth in front of it, `http://169.254.169.254`
 * reaches cloud instance metadata, and a LAN address reaches whatever else runs
 * in the deployment's network. The check is on the resolved address rather than
 * the hostname, because a name the attacker controls can point anywhere.
 */

/** IPv4 ranges that must never be fetched, as [network, prefix length]. */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255 broadcast
];

function v4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    // Rejects '', '01', '256' and anything non-numeric. Leading zeros matter:
    // some resolvers read them as octal, so they are not merely cosmetic.
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedV4(address: string): boolean {
  const value = v4ToInt(address);
  if (value === null) return true; // unparseable — refuse rather than guess

  return BLOCKED_V4.some(([network, bits]) => {
    const base = v4ToInt(network);
    if (base === null) return false;
    // `>>> 0` keeps the mask unsigned; a /0 would shift by 32 and is not used.
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  });
}

/**
 * Expands an IPv6 address to its eight 16-bit groups, resolving `::` and any
 * dotted-quad tail. Returns null for anything malformed.
 *
 * A real parse rather than string prefixes, because the embedded-IPv4 forms
 * have two spellings and both occur in the wild: `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` are the same address. Matching only the readable one blocks
 * an attacker's address and admits nothing, but blocking on the prefix alone
 * has the opposite failure — every NAT64 address is written in hex, so it
 * rejects legitimate public sites on any IPv6-only or DNS64 network.
 */
function v6Groups(address: string): number[] | null {
  const value = address.toLowerCase().split('%')[0] ?? ''; // drop any zone id

  // A dotted-quad tail is the low 32 bits; rewrite it as two hex groups so the
  // rest of this function only has one form to think about.
  let normalised = value;
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(value);
  if (dotted?.[1] && dotted[2]) {
    const embedded = v4ToInt(dotted[2]);
    if (embedded === null) return null;
    const high = ((embedded >>> 16) & 0xffff).toString(16);
    const low = (embedded & 0xffff).toString(16);
    normalised = `${dotted[1]}${high}:${low}`;
  }

  const halves = normalised.split('::');
  if (halves.length > 2) return null; // '::' may appear at most once

  const toGroups = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const groups: number[] = [];
    for (const chunk of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
    return groups;
  };

  const lead = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!lead || !tail) return null;

  if (halves.length === 1) return lead.length === 8 ? lead : null;

  const gap = 8 - lead.length - tail.length;
  if (gap < 0) return null;
  return [...lead, ...new Array<number>(gap).fill(0), ...tail];
}

function isBlockedV6(address: string): boolean {
  const groups = v6Groups(address);
  if (!groups) return true; // unparseable — refuse rather than guess

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (the well-known NAT64 prefix)
  // both carry a v4 address in the low 32 bits. Judged on that address, so
  // ::ffff:127.0.0.1 is blocked as loopback while 64:ff9b::c689:966f — a real
  // public host behind DNS64 — is allowed.
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (mapped || nat64) {
    const embedded = `${g6 >>> 8}.${g6 & 0xff}.${g7 >>> 8}.${g7 & 0xff}`;
    return isBlockedV4(embedded);
  }

  if (groups.every((group) => group === 0)) return true; // ::  unspecified
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8  multicast

  return false;
}

/** True when an address must not be fetched. Unknown formats are blocked. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family === 6) return isBlockedV6(address);
  return true;
}

export class BlockedAddressError extends Error {
  constructor(hostname: string) {
    super(
      `"${hostname}" resolves to a private or reserved address, so it cannot be imported. ` +
        'Use the public URL of your website.',
    );
    this.name = 'BlockedAddressError';
  }
}

/**
 * Resolves a hostname and rejects it if any address is private or reserved.
 *
 * *Every* address is checked, not just the first: a host resolving to both a
 * public and a private address would otherwise be fetchable by whichever the
 * connection happened to pick.
 *
 * Residual risk, stated plainly: this validates, then `fetch` resolves again on
 * its own, so a DNS record whose answer changes between the two calls (a
 * rebinding attack) is not covered. Closing it means pinning the connection to
 * the validated address, which undici only allows through a custom agent. The
 * remaining exposure is a deliberate attack against a first-party B2B feature
 * rather than a drive-by, and it is worth fixing before this endpoint is
 * reachable by untrusted signups.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  // A literal IP never reaches the resolver, so check it directly.
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new BlockedAddressError(hostname);
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve "${hostname}". Check the address and try again.`);
  }

  if (addresses.length === 0) throw new BlockedAddressError(hostname);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new BlockedAddressError(hostname);
  }
}
