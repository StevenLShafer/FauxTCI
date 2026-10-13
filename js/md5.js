// FauxTCI: a compact MD5 (RFC 1321) over the UTF-8 bytes of a string.
//
// WHY IT EXISTS: the TCI API's `model.hash` is "md5:" followed by the MD5 of
// the serialised model parameters (tciApiHash() in R/tci-api.R, which
// writes jsonlite::toJSON() of the parameters rounded to ten significant
// digits to a file and runs tools::md5sum() on it).  A browser page has no
// synchronous MD5 (SubtleCrypto offers SHA only, asynchronously), so the port
// carries its own, written against RFC 1321 and checked by the known-answer
// tests in test/tci.test.js.  Nothing here is security-relevant: the hash is
// a fingerprint that lets two responses from one model compare by one string.
//
// Drafted by Claude Code, 2026-10-12, at the request of Steven L. Shafer.

// Per-round shift amounts, RFC 1321 section 3.4.
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// The sine-derived constants T[i] = floor(2^32 * |sin(i + 1)|), tabulated
// rather than computed so the table does not depend on Math.sin()'s last bit.
const T = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

const hex32 = (x) => {
  // Little-endian byte order, two hex digits per byte, as the digest is defined.
  let out = "";
  for (let i = 0; i < 4; i++) out += ((x >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  return out;
};

/**
 * MD5 of a byte array (Uint8Array or array of 0..255), as 32 lower-case hex
 * digits.  RFC 1321, with the message padded to 56 mod 64 bytes and the bit
 * length appended as a 64-bit little-endian integer.
 */
export function md5Bytes(bytes) {
  const length = bytes.length;
  // Padded length: the message, 0x80, zeros to 56 mod 64, then 8 length bytes.
  const padded = new Uint8Array(((length + 8) >>> 6) * 64 + 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const bits = length * 8;
  // The bit length as two 32-bit little-endian words (fine below 2^53 bits).
  const low = bits >>> 0;
  const high = Math.floor(bits / 0x100000000) >>> 0;
  const n = padded.length;
  for (let i = 0; i < 4; i++) {
    padded[n - 8 + i] = (low >>> (8 * i)) & 0xff;
    padded[n - 4 + i] = (high >>> (8 * i)) & 0xff;
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Array(16);

  for (let offset = 0; offset < n; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + 4 * i;
      M[i] = padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const sum = (A + F + T[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(sum, SHIFTS[i])) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }
  return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
}

/** MD5 of a string's UTF-8 encoding, as 32 lower-case hex digits. */
export function md5(text) {
  return md5Bytes(new TextEncoder().encode(String(text)));
}
