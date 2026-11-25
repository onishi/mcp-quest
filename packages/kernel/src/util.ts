/** Small deterministic helpers: hashing, ids, dice, world-day. */

/** Non-cryptographic 53-bit hash (cyrb53) used for payload fingerprints and RNG streams. */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function payloadHash(value: unknown): string {
  const s = canonical(value);
  return `${hash53(s).toString(16)}-${hash53(s, 7).toString(16)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16)}`;
}

export function randomSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic dice stream: the n-th roll of a turn depends only on
 * (seed, turn, n), so a recorded action can be replayed exactly (spec §5.5).
 */
export class DiceStream {
  private n = 0;
  readonly rolls: Array<{ expr: string; rolls: number[]; total: number }> = [];
  constructor(
    private readonly seed: string,
    private readonly turn: number,
  ) {}

  private next(sides: number): number {
    const h = hash53(`${this.seed}:${this.turn}:${this.n++}`);
    return (h % sides) + 1;
  }

  /** Roll an expression like "1d20", "2d4+2", "1d3" or a constant "3". */
  roll(expr: string): number {
    const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr);
    if (!m) {
      const c = Number.parseInt(expr, 10);
      if (Number.isNaN(c)) throw new Error(`bad dice ${expr}`);
      this.rolls.push({ expr, rolls: [], total: c });
      return c;
    }
    const count = Number(m[1]);
    const sides = Number(m[2]);
    const mod = m[3] ? Number(m[3]) : 0;
    const rolls = Array.from({ length: count }, () => this.next(sides));
    const total = rolls.reduce((a, b) => a + b, 0) + mod;
    this.rolls.push({ expr, rolls, total });
    return total;
  }

  d20(): number {
    return this.roll("1d20");
  }
}

/** World day boundary is 04:00 JST (= 19:00 UTC of the previous day). */
export function worldDay(now: Date): string {
  const shifted = new Date(now.getTime() + (9 - 4) * 3600_000);
  return shifted.toISOString().slice(0, 10);
}

/** Next boundary (04:00 JST) after `now`, as ISO string. */
export function nextDayBoundary(now: Date): string {
  const day = worldDay(now);
  const boundary = new Date(`${day}T19:00:00.000Z`); // 04:00 JST next calendar day
  return boundary.toISOString();
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86400_000);
}
