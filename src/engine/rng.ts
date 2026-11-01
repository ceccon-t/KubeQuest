/** Deterministic xorshift128+ RNG. The engine must never call Math.random. */
export class Rng {
  private s0: number;
  private s1: number;
  constructor(seed: number) {
    // splitmix32 to expand the seed into two non-zero state words
    let x = (seed >>> 0) || 0x9e3779b9;
    const next = (): number => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next() || 1;
    this.s1 = next() || 2;
  }
  /** Uniform float in [0, 1). */
  next(): number {
    let s1 = this.s0;
    const s0 = this.s1;
    this.s0 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.s1 = s1 >>> 0;
    return ((this.s0 + this.s1) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('pick from empty array');
    return arr[this.int(arr.length)] as T;
  }
  /** Random suffix like the ones the API server generates (5 chars, restricted alphabet). */
  suffix(len = 5): string {
    // upstream: k8s.io/apimachinery/pkg/util/rand — alphabet without vowels/ambiguous chars
    const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[this.int(alphabet.length)];
    return out;
  }
  /** Pod-template-hash style: 8-10 chars from the same alphabet (upstream uses SafeEncodeString of an fnv hash). */
  hash(input: string): string {
    // FNV-1a 32-bit, then encode with the safe alphabet like upstream rand.SafeEncodeString
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
    const digits = String(h);
    let out = '';
    for (const d of digits) out += alphabet[d.charCodeAt(0) % alphabet.length];
    return out;
  }
}
