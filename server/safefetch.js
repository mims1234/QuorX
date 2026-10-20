// fetch_url's network access: public https pages only. Every hop (the first address and each redirect) is checked
// by the address its name resolves to, so a name or a redirect can't lead to this computer or the local network.
import dns from 'node:dns/promises';
import net from 'node:net';

// Private, loopback, link-local (cloud metadata), carrier-grade NAT, multicast and reserved ranges.
const BLOCK4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
const toInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
function privateV4(ip) { const n = toInt(ip); return BLOCK4.some(([b, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(toInt(b) / 2 ** (32 - bits))); }
export function privateAddress(ip) {
  const a = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return privateV4(a);
  if (!net.isIPv6(a)) return true;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return a === '::' || a === '::1' || /^(fc|fd|fe[89ab]|ff)/.test(a) || /^::ffff:/.test(a) || /^64:ff9b:/.test(a);
}

// The name lookup, replaceable in tests (they run without a network).
export const resolver = { lookup: async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address) };
async function checkHost(u) {
  if (u.protocol !== 'https:') throw new Error('only https:// pages can be fetched');
  if (u.username || u.password) throw new Error('addresses with a user name or password are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : await resolver.lookup(host);
  if (!ips.length || ips.some(privateAddress)) throw new Error('local and private addresses are not allowed; use the browser tool for your own apps');
}

/** GET a public https page, following up to 5 redirects, each checked. Returns the final Response and URL. */
export async function safeFetch(url, { signal, headers } = {}) {
  let u = new URL(String(url));
  for (let hop = 0; hop <= 5; hop++) {
    await checkHost(u);
    const r = await fetch(u, { signal, headers, redirect: 'manual' });
    const to = r.status >= 300 && r.status < 400 && r.headers.get('location');
    if (!to) return { response: r, url: u };
    u = new URL(to, u);
  }
  throw new Error('too many redirects');
}
