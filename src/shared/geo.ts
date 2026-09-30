// ---------------------------------------------------------------------------
// Haversine distance (quick local filter before any travel-time lookup)
// ---------------------------------------------------------------------------

export function haversineDistanceMiles(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
