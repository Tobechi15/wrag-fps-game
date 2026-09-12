// Must stay in sync with client/src/extraction.js's ZONE_POSITIONS/ZONE_RADIUS.
// Three zones now (was one) - a single extraction point doesn't scale to a
// battle-royale-sized lobby (up to VERSUS_MATCH_SIZE participants, see
// modes.js) spread across SPAWN_POINTS as far out as +-45; one shared point
// would just become a chokepoint/camping spot for the whole match. Spread
// across three distinct areas of the map, each comfortably clear of every
// wall in map/walls.js's WALLS and every corner/edge spawn point in
// match.js's SPAWN_POINTS (checked against both, not just eyeballed).
export const EXTRACTION_ZONES = [
  { center: { x: 0, z: 4 }, radius: 2 },
  { center: { x: 20, z: 20 }, radius: 2 },
  { center: { x: -20, z: -20 }, radius: 2 },
];

const REQUIRED_SECONDS_TO_BANK = 3;
const MAX_DELTA_SECONDS = 0.2; // clamp so a lagging client can't fast-forward its zone timer

// Coop's whole team shares one goal rather than needing several chokepoints
// spread across the map (see modes.js's singleExtractionZone) - just the
// first of the three zones above, same one client/src/extraction.js falls
// back to for the same mode.
function getZonesForMode(modeConfig) {
  return modeConfig?.singleExtractionZone ? [EXTRACTION_ZONES[0]] : EXTRACTION_ZONES;
}

function isInsideAnyZone(position, zones) {
  return zones.some((zone) => {
    const dx = position.x - zone.center.x;
    const dz = position.z - zone.center.z;
    return dx * dx + dz * dz <= zone.radius ** 2;
  });
}

// Given a player's new position and how long it's been since their last
// move update, returns their updated zone-dwell time and whether they just
// banked. The server derives dwell time purely from the position-update
// stream it already receives for multiplayer sync - it never trusts a
// client's own claim of "I've been here long enough." Any one of the zones
// counts - a player doesn't need to return to the SAME zone they started
// dwelling in (moot in practice: leaving any zone already resets
// secondsInZone to 0 below, so they're never in two zones' progress at once).
export function updateExtractionState(position, previousSecondsInZone, deltaSecondsRaw, modeConfig) {
  const deltaSeconds = Math.min(deltaSecondsRaw, MAX_DELTA_SECONDS);

  const isInsideZone = isInsideAnyZone(position, getZonesForMode(modeConfig));

  let secondsInZone = isInsideZone ? previousSecondsInZone + deltaSeconds : 0;
  const didBank = secondsInZone >= REQUIRED_SECONDS_TO_BANK;
  if (didBank) secondsInZone = 0;

  return { secondsInZone, didBank };
}
