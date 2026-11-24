/** Pure helpers for encodings the simulator needs without runtime dependencies: base64, SHA-256, simulated X.509. */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function b64encode(s: string): string {
  const b = utf8Bytes(s);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] as string;
    out += B64[(n >> 12) & 63] as string;
    out += i + 1 < b.length ? (B64[(n >> 6) & 63] as string) : '=';
    out += i + 2 < b.length ? (B64[n & 63] as string) : '=';
  }
  return out;
}

/** Decode base64 to a UTF-8 string; returns undefined when the input is not valid base64. */
export function b64decode(s: string): string | undefined {
  const clean = s.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const q = [0, 1, 2, 3].map((k) => { const ch = clean[i + k] as string; return ch === '=' ? 0 : B64.indexOf(ch); });
    const n = ((q[0] as number) << 18) | ((q[1] as number) << 12) | ((q[2] as number) << 6) | (q[3] as number);
    bytes.push((n >> 16) & 255);
    if (clean[i + 2] !== '=') bytes.push((n >> 8) & 255);
    if (clean[i + 3] !== '=') bytes.push(n & 255);
  }
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const c = bytes[i] as number;
    if (c < 0x80) { out += String.fromCharCode(c); i++; }
    else if (c < 0xe0) { out += String.fromCharCode(((c & 31) << 6) | ((bytes[i + 1] ?? 0) & 63)); i += 2; }
    else if (c < 0xf0) { out += String.fromCharCode(((c & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) | ((bytes[i + 2] ?? 0) & 63)); i += 3; }
    else { out += String.fromCodePoint(((c & 7) << 18) | (((bytes[i + 1] ?? 0) & 63) << 12) | (((bytes[i + 2] ?? 0) & 63) << 6) | ((bytes[i + 3] ?? 0) & 63)); i += 4; }
  }
  return out;
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256hex(s: string): string {
  const bytes = utf8Bytes(s);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? Math.floor(bitLen / 2 ** (i * 8)) & 255 : (bitLen >>> (i * 8)) & 255);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (((bytes[off + i * 4] as number) << 24) | ((bytes[off + i * 4 + 1] as number) << 16) | ((bytes[off + i * 4 + 2] as number) << 8) | (bytes[off + i * 4 + 3] as number)) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number, b = w[i - 2] as number;
      w[i] = (((w[i - 16] as number) + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + (w[i - 7] as number) + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0);
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0; h[1] = ((h[1] as number) + b) >>> 0; h[2] = ((h[2] as number) + c) >>> 0; h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0; h[5] = ((h[5] as number) + f) >>> 0; h[6] = ((h[6] as number) + g) >>> 0; h[7] = ((h[7] as number) + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/**
 * Certificates are simulated: the PEM body is base64 of a small descriptor instead of DER, so the simulator can
 * tell who a certificate was issued to and by whom without an ASN.1 parser. The PEM armour is the real one.
 */
export interface CertInfo { subject: string; sans: string[]; issuer: string; notAfter: string }

export function makeCertPem(c: CertInfo): string {
  const body = b64encode(`kq-x509\nsubject=${c.subject}\nsan=${c.sans.join(',')}\nissuer=${c.issuer}\nnotAfter=${c.notAfter}\n`);
  return `-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
}
export function makeKeyPem(subject: string): string {
  const body = b64encode(`kq-key\nsubject=${subject}\n${'0'.repeat(96)}\n`);
  return `-----BEGIN PRIVATE KEY-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
}
export function parseCertPem(pem: string): CertInfo | undefined {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) return undefined;
  const text = b64decode(m[1] as string);
  if (!text?.startsWith('kq-x509\n')) return undefined;
  const get = (k: string): string => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1] ?? '';
  return { subject: get('subject'), sans: get('san').split(',').filter((x) => x), issuer: get('issuer'), notAfter: get('notAfter') };
}
