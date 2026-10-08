/**
 * Deterministic mock distances for mock mode.
 * In production these come from the real Places/Events APIs; in mock mode we
 * derive a STABLE per-venue distance (0.4–3.5 km) from the venue id so results
 * sort consistently near-first across calls.
 */
export function mockDistanceKm(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 100000;
  }
  return Math.round((0.4 + (h % 32) / 10) * 10) / 10;
}
