import { isPathClear } from './walls.js';

// Hand-placed waypoints spread across the map's open lanes (see walls.js's
// layout comment) - every node here is verified clear of every wall. Edges
// between them are NOT hand-specified; buildNavGraph() below connects any
// two nodes within MAX_EDGE_DISTANCE whose straight-line path doesn't cross
// a wall, so the graph stays correct automatically if WALLS or NAV_NODES
// change, instead of relying on someone re-checking every pair by hand.
export const NAV_NODES = [
  { x: 0, z: -11 },   // N0 - target range, center
  { x: -6, z: -9 },   // N1 - target range, west
  { x: 6, z: -9 },    // N2 - target range, east
  { x: 0, z: -5 },    // N3 - open center lane, between the chokepoint walls
  { x: -6, z: -5 },   // N4 - west of the west chokepoint wall
  { x: 6, z: -5 },    // N5 - east of the east chokepoint wall
  { x: -9, z: -1 },   // N6 - far west lane
  { x: 9, z: -1 },    // N7 - far east lane
  { x: -3, z: -1 },   // N8 - between the west bunker and the west pillar
  { x: 3, z: -1 },    // N9 - between the east bunker and the east pillar
  { x: 0, z: -3 },    // N10 - center lane, just north of the pillars
  { x: 0, z: 0.5 },   // N11 - the gap between the two center pillars
  { x: -3, z: 2 },    // N12 - southwest of center, extraction approach
  { x: 3, z: 2 },     // N13 - southeast of center, extraction approach
  { x: 0, z: 4.5 },   // N14 - at the extraction zone
  { x: -9, z: 6 },    // N15 - southwest lane, past the extraction cover
  { x: 9, z: 6 },     // N16 - southeast lane, past the extraction cover
  { x: 0, z: 9 },     // N17 - south side, between the extraction cover pieces
  { x: -9, z: -9 },   // N18 - northwest corner
  { x: 9, z: -9 },    // N19 - northeast corner
  { x: -9, z: 9 },    // N20 - southwest corner
  { x: 9, z: 9 },     // N21 - southeast corner

  // Outer ring, added when match.js's SPAWN_POINTS moved much farther out
  // (see walls.js's matching outposts/lane cover). Each is offset to the
  // side of the direct spawn-to-center diagonal rather than sitting on it,
  // so a bot's very first patrol leg (spawn straight to its nearest node -
  // not yet a verified graph edge, see bot.js) doesn't run straight through
  // the very obstacle placed on that diagonal.
  { x: -9, z: -14 },  // N22 - near the northwest outpost
  { x: 9, z: -14 },   // N23 - near the northeast outpost
  { x: -9, z: 14 },   // N24 - near the southwest outpost
  { x: 9, z: 14 },    // N25 - near the southeast outpost
  { x: 0, z: -13 },   // N26 - between the north lane cover pair
  { x: 0, z: 13 },    // N27 - between the south lane cover pair
  { x: -13, z: 0 },   // N28 - between the west lane cover pair
  { x: 13, z: 0 },    // N29 - between the east lane cover pair
];

const MAX_EDGE_DISTANCE = 9; // meters - wide enough to link neighboring nodes, narrow enough to skip far-flung ones buildNavGraph would just reject anyway

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// Builds the adjacency list once from NAV_NODES/WALLS (both fixed, so this
// only needs to run once at module load, not per match): node i connects to
// node j when they're within range AND nothing walls off the straight line
// between them. Returns { nodes, adjacency } where adjacency[i] is the list
// of node indices reachable directly from node i.
function buildNavGraph() {
  const adjacency = NAV_NODES.map(() => []);
  for (let i = 0; i < NAV_NODES.length; i++) {
    for (let j = i + 1; j < NAV_NODES.length; j++) {
      if (distance2D(NAV_NODES[i], NAV_NODES[j]) > MAX_EDGE_DISTANCE) continue;
      if (!isPathClear(NAV_NODES[i], NAV_NODES[j])) continue;
      adjacency[i].push(j);
      adjacency[j].push(i);
    }
  }
  return { nodes: NAV_NODES, adjacency };
}

export const NAV_GRAPH = buildNavGraph();

// The node closest to an arbitrary world position (straight-line distance,
// ignoring walls) - used to seed a bot's starting node from its spawn
// point, which won't usually land exactly on a node.
export function findNearestNode(position) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < NAV_NODES.length; i++) {
    const distance = distance2D(NAV_NODES[i], position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  return nearestIndex;
}
