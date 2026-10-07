import { haversineDistanceMiles } from "../shared/geo";

// ---------------------------------------------------------------------------
// TravelTimeProvider — the seam where the full system plugs in live Google
// Maps estimates (batched, cached and cost-controlled; that layer is private).
//
// The solver only ever asks for a batch of point-to-point legs and sums them
// along each trip's waypoint chain, so anything that can price a leg can
// drive it. Two toy implementations ship here:
//   - HaversineProvider: straight-line miles at a fixed average speed. This is
//     the same shape as the full system's offline/dev fallback.
//   - MatrixProvider: a fixed lookup table, used by tests that need exact,
//     hand-picked travel times.
// ---------------------------------------------------------------------------

export interface Waypoint {
  address: string;
  lat: number;
  lng: number;
}

export interface Leg {
  from: Waypoint;
  to: Waypoint;
}

export interface LegEstimate {
  miles: number;
  minutes: number;
}

export interface TravelTimeProvider {
  readonly name: string;
  /** Price every leg. Must return one estimate per input leg, same order. */
  estimateLegs(legs: Leg[]): Promise<LegEstimate[]>;
}

/**
 * TOY PROVIDER — straight-line distance at a constant speed. Real roads are
 * longer and slower than this, so schedules built on it are optimistic; the
 * production path never uses it for committed schedules.
 */
export class HaversineProvider implements TravelTimeProvider {
  readonly name = "haversine";

  constructor(private readonly mph: number = 45) {
    if (!(mph > 0)) throw new Error("HaversineProvider: mph must be positive");
  }

  async estimateLegs(legs: Leg[]): Promise<LegEstimate[]> {
    return legs.map(({ from, to }) => {
      const miles = haversineDistanceMiles(from.lat, from.lng, to.lat, to.lng);
      return { miles, minutes: (miles / this.mph) * 60 };
    });
  }
}

export function legKey(from: string, to: string): string {
  return `${from}|${to}`;
}

/**
 * TOY PROVIDER — looks legs up by "fromAddress|toAddress". A leg from an
 * address to itself is free. Unknown legs throw unless a fallback provider is
 * given, so a test can never silently price a leg it did not intend to.
 */
export class MatrixProvider implements TravelTimeProvider {
  readonly name = "matrix";

  constructor(
    private readonly table: Record<string, LegEstimate>,
    private readonly fallback?: TravelTimeProvider,
  ) {}

  async estimateLegs(legs: Leg[]): Promise<LegEstimate[]> {
    const out: LegEstimate[] = new Array(legs.length);
    const misses: number[] = [];
    legs.forEach((leg, i) => {
      if (leg.from.address === leg.to.address) {
        out[i] = { miles: 0, minutes: 0 };
        return;
      }
      const key = legKey(leg.from.address, leg.to.address);
      if (Object.hasOwn(this.table, key)) out[i] = this.table[key];
      else misses.push(i);
    });

    if (misses.length > 0) {
      if (!this.fallback) {
        const leg = legs[misses[0]];
        throw new Error(`MatrixProvider: no estimate for leg ${legKey(leg.from.address, leg.to.address)}`);
      }
      const filled = await this.fallback.estimateLegs(misses.map((i) => legs[i]));
      misses.forEach((legIdx, j) => { out[legIdx] = filled[j]; });
    }
    return out;
  }
}
