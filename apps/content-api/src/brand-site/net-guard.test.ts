import { describe, expect, it } from 'vitest';
import { isBlockedAddress } from './net-guard.js';

/**
 * This is the only place in the service that fetches a URL the user chose, so
 * this function is the whole boundary between a brand-import feature and a
 * request-forgery primitive. A regression here fails silently and in our
 * favour — the fetch succeeds, the import works, and nobody notices until
 * someone points it at the metadata endpoint. Hence the table.
 */
describe('isBlockedAddress', () => {
  const blocked = [
    ['loopback', '127.0.0.1'],
    ['loopback, non-canonical', '127.99.42.7'],
    ['private, 10/8', '10.0.0.1'],
    ['private, 172.16/12 low', '172.16.0.1'],
    ['private, 172.16/12 high', '172.31.255.254'],
    ['private, 192.168/16', '192.168.1.1'],
    ['link-local', '169.254.1.1'],
    ['cloud instance metadata', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['this network', '0.0.0.0'],
    ['IETF protocol assignments', '192.0.0.1'],
    ['benchmarking', '198.18.0.1'],
    ['multicast', '224.0.0.1'],
    ['reserved', '240.0.0.1'],
    ['broadcast', '255.255.255.255'],
    ['v6 loopback', '::1'],
    ['v6 unspecified', '::'],
    ['v6 unique local', 'fd00::1'],
    ['v6 unique local, fc00 half', 'fc00::1'],
    ['v6 link-local', 'fe80::1'],
    ['v6 multicast', 'ff02::1'],
  ] as const;

  for (const [label, address] of blocked) {
    it(`blocks ${label} (${address})`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = [
    ['a public v4', '93.184.216.34'],
    ['Google DNS', '8.8.8.8'],
    ['just outside 172.16/12', '172.32.0.1'],
    ['just below 172.16/12', '172.15.255.255'],
    ['just outside CGNAT', '100.128.0.1'],
    ['a public v6', '2606:2800:220:1:248:1893:25c8:1946'],
  ] as const;

  for (const [label, address] of allowed) {
    it(`allows ${label} (${address})`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }

  /**
   * The bypass worth having a test for. `::ffff:127.0.0.1` is a loopback
   * address wearing a v6 costume: it matches none of the v6 prefixes, so a
   * check that only compared those would wave it straight through to a fetch
   * of our own API.
   */
  it('blocks IPv4-mapped loopback', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses', () => {
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('blocks NAT64-embedded private addresses', () => {
    expect(isBlockedAddress('64:ff9b::10.0.0.1')).toBe(true);
  });

  it('allows an IPv4-mapped public address to be judged on the inner address', () => {
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  /**
   * Both embedded-IPv4 forms spell the same address, and only the readable one
   * is obvious. Matching on the textual prefix alone got this backwards in
   * exactly one direction that testing against live sites exposed: stripe.com
   * resolves to 64:ff9b::c689:966f behind DNS64, whose embedded address is the
   * entirely public 198.137.150.111 — and it was refused as "private".
   */
  it('decodes a hex-form NAT64 address to the public IPv4 inside it', () => {
    // 64:ff9b::c689:966f == 198.137.150.111
    expect(isBlockedAddress('64:ff9b::c689:966f')).toBe(false);
  });

  it('still blocks a hex-form NAT64 address wrapping a private IPv4', () => {
    // 64:ff9b::7f00:1 == 127.0.0.1, and 64:ff9b::a00:1 == 10.0.0.1
    expect(isBlockedAddress('64:ff9b::7f00:1')).toBe(true);
    expect(isBlockedAddress('64:ff9b::a00:1')).toBe(true);
  });

  it('blocks the hex form of IPv4-mapped loopback', () => {
    // ::ffff:7f00:1 == ::ffff:127.0.0.1
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true);
    // ::ffff:a9fe:a9fe == ::ffff:169.254.169.254, the metadata endpoint
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('expands :: correctly wherever it sits', () => {
    expect(isBlockedAddress('fe80:0:0:0:0:0:0:1')).toBe(true);
    expect(isBlockedAddress('2001:db8:0:0:0:0:0:1')).toBe(false);
    expect(isBlockedAddress('2001:db8::1')).toBe(false);
  });

  it('rejects an address with two :: runs, which is not a valid address', () => {
    expect(isBlockedAddress('2001::db8::1')).toBe(true);
  });

  /** Refusing the unparseable is the safe direction: a hostname, an empty
   *  string, or an octal-looking octet must never be treated as public. */
  it('blocks anything it cannot parse as an address', () => {
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('localhost')).toBe(true);
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
    expect(isBlockedAddress('127.0.0.01')).toBe(true);
  });
});
