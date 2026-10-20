// HTTPS for other devices. A phone on your Wi-Fi reaches QuorX over the network, where anyone on the same network
// could read plain HTTP (the pairing link, the cookie, every chat). So the network side speaks TLS, with a
// certificate made for this install: self-signed, kept in data/tls/ (this account only, never in a project), its
// SHA-256 fingerprint shown on the pairing screen so you can compare it on the phone before you continue.
// This computer (loopback) keeps plain HTTP: the desktop app, the app link and local tools are unchanged.
//
// One port does both: the first byte of a connection tells TLS (a handshake starts with 0x16) from plain HTTP.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from './openrouter.js';

const DIR = path.join(HOME, 'data', 'tls');
export const KEY_FILE = path.join(DIR, 'lan-key.pem');
export const CERT_FILE = path.join(DIR, 'lan-cert.pem');
const DAYS = 825; // the longest validity Apple's devices accept for a server certificate
const RENEW_DAYS = 30;

// ---------- a minimal DER writer, enough for one X.509 v3 certificate ----------
const len = (n) => (n < 0x80 ? Buffer.from([n]) : (() => { const b = []; for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff); return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (s) => { const n = s.split('.').map(Number); const out = [n[0] * 40 + n[1]]; for (const v of n.slice(2)) { const b = [v & 0x7f]; for (let x = v >> 7; x > 0; x >>= 7) b.unshift(0x80 | (x & 0x7f)); out.push(...b); } return tlv(0x06, Buffer.from(out)); };
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = (d) => { const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${s.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${s}Z`)); };
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

/** This computer's names and IPv4 addresses, for the certificate's subjectAltName. */
function names() {
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const dns = ['localhost', ...(host ? [host, `${host}.local`] : [])];
  const ips = ['127.0.0.1', ...Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a.address)];
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

/** A new self-signed certificate (ECDSA P-256, SHA-256) for this install: { key, cert } as PEM. */
export function makeCert(now = new Date()) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x7f) | 0x01; // positive, no leading zero byte
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8(`QuorX on ${os.hostname()}`.slice(0, 64)))), set(seq(oid('2.5.4.10'), utf8('QuorX'))));
  const { dns, ips } = names();
  const san = seq(...dns.map((d) => tlv(0x82, Buffer.from(d))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial), alg, name,
    seq(time(new Date(now.getTime() - 3600e3)), time(new Date(now.getTime() + DAYS * 86400e3))),
    name, spki,
    tlv(0xa3, seq(
      ext('2.5.29.19', true, seq()), // basicConstraints: not a CA
      ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      ext('2.5.29.17', false, san),
      ext('2.5.29.14', false, tlv(0x04, crypto.createHash('sha1').update(spki).digest())), // subjectKeyIdentifier
    )),
  );
  const sig = crypto.sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert };
}

let cached = null;
/**
 * This install's certificate, made on first use and again when it is near its end (then the fingerprint changes):
 * { key, cert, fingerprint, validTo }.
 */
export function lanCert() {
  if (cached && Date.parse(cached.validTo) - Date.now() > RENEW_DAYS * 86400e3) return cached;
  let key, cert;
  try {
    key = fs.readFileSync(KEY_FILE, 'utf8'); cert = fs.readFileSync(CERT_FILE, 'utf8');
    const x = new crypto.X509Certificate(cert);
    if (!x.checkPrivateKey(crypto.createPrivateKey(key)) || Date.parse(x.validTo) - Date.now() < RENEW_DAYS * 86400e3) throw new Error('renew');
  } catch {
    ({ key, cert } = makeCert());
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    fs.writeFileSync(CERT_FILE, cert, { mode: 0o644 });
  }
  const x = new crypto.X509Certificate(cert);
  cached = { key, cert, fingerprint: x.fingerprint256, validTo: x.validTo };
  return cached;
}
/** The fingerprint the pairing screen shows, or null when there is no certificate yet. */
export function lanFingerprint() { try { return lanCert().fingerprint; } catch { return null; } }

/**
 * A listener for the network side, in front of `httpServer` (whose request handler serves both): TLS connections
 * are decrypted and handed to it; plain HTTP is handed over as it is (QuorX answers plain requests from other
 * devices with a redirect to https, server/access.js → plainLan).
 */
export function serveLan(httpServer) {
  const { key, cert } = lanCert();
  const secure = tls.createServer({ key, cert, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
  secure.on('secureConnection', (s) => httpServer.emit('connection', s));
  secure.on('tlsClientError', (_e, s) => s?.destroy()); // a phone that refused the certificate, or a port scan
  const front = net.createServer((sock) => {
    sock.on('error', () => sock.destroy());
    sock.setTimeout(30e3, () => sock.destroy()); // until the first byte; the HTTP server keeps its own timeouts
    sock.once('data', (first) => {
      sock.setTimeout(0);
      sock.pause();
      sock.unshift(first);
      (first[0] === 0x16 ? secure : httpServer).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
  });
  front.on('close', () => secure.close());
  return front;
}
