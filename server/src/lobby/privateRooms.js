import { randomInt } from 'crypto';
import {
  deductStake, refundStake, recordStakeCollected, recordStakeRefunded,
} from '../economy/wallet.js';

const CODE_LENGTH = 6;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - easy to misread out loud/over text
const MAX_ROOM_SIZE = 8; // same headcount as the public queues - no bots fill a private room, it's invite-only by design

// Invite-only rooms for Private mode - parallel to queue.js's public queue,
// but nothing here auto-starts on a timer or a fill count. A room only
// becomes a real match when its host explicitly starts it (see start()
// below), same "playable solo" allowance queue.js already has (a host can
// start with just themselves in the room).
//
// Private has no FIXED stake like Versus/Coop (see modes.js's entryStake) -
// "by choice, depending on the setting of the room," per the user, with
// whoever wins the match claiming the whole pool. The host sets the room's
// stake once at creation; every joiner pays that same amount to get in.
// Anonymous players can't actually pay (there's no persisted balance to
// deduct from - no account at all), so they're let in for free rather than
// blocked - they just contribute nothing to the pool and, per the user,
// can never be paid OUT of it either even if they end up "winning" (see
// match.js's stake-pool payout, which only ever credits a real userId).
export function createPrivateRoomRegistry({ onMatchStart }) {
  const rooms = new Map(); // code -> { hostId, stake, pool, members: Map<id, {socket, callsign, userId, characterVariant, stakePaid}> }
  const roomCodeByMemberId = new Map(); // id -> code, so leave()/create() can find/clean up a member's current room without the caller tracking it

  function generateCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function broadcastRoomUpdate(code) {
    const room = rooms.get(code);
    if (!room) return;
    const members = Array.from(room.members.entries()).map(([id, member]) => ({ id, callsign: member.callsign }));
    const message = JSON.stringify({
      type: 'room-update', code, hostId: room.hostId, stake: room.stake, pool: room.pool, members,
    });
    for (const { socket } of room.members.values()) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  }

  // Removes a member from whatever room they're currently in, if any -
  // used both by the explicit leave() below and defensively before create/
  // join, so a player can't end up double-booked into two rooms (mirrors
  // index.js's defensive versusQueue/coopQueue leave-before-join pattern).
  // Refunds whatever THIS member personally paid into the pool - nobody
  // should be charged for a match they left before it started, same
  // reasoning as index.js's queue-stake refund.
  function leave(id) {
    const code = roomCodeByMemberId.get(id);
    if (!code) return;
    const room = rooms.get(code);
    roomCodeByMemberId.delete(id);
    if (!room) return;

    const member = room.members.get(id);
    room.members.delete(id);
    if (member?.stakePaid > 0) {
      room.pool -= member.stakePaid;
      refundStake(member.userId, member.stakePaid).catch((err) => {
        console.error(`Failed to refund room stake for user ${member.userId}:`, err);
      });
      recordStakeRefunded(member.stakePaid).catch((err) => {
        console.error('Failed to record room-stake refund in house ledger:', err);
      });
    }

    if (room.members.size === 0) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === id) {
      // Host left without starting - hand it to whoever's been in the room
      // longest (Map iteration order = insertion order) rather than
      // deleting a room its other members are still sitting in.
      room.hostId = room.members.keys().next().value;
    }
    broadcastRoomUpdate(code);
  }

  // Attempts to charge `stake` to a real player joining/creating a room -
  // returns true if they're in (paid or exempt), false if they couldn't
  // afford it OR a DB error occurred (either way, caller sends room-error
  // and does NOT add them - fail closed, never let someone into a staked
  // room without a confirmed payment). Anonymous players (no userId)
  // always succeed for free - see the module comment.
  async function tryPayStake(socket, userId, stake, code) {
    if (stake <= 0 || !userId) return { ok: true, paid: 0 };
    let newBalance;
    try {
      newBalance = await deductStake(userId, stake);
    } catch (err) {
      console.error(`Failed to deduct room stake for user ${userId}:`, err);
      socket.send(JSON.stringify({ type: 'room-error', reason: 'server-error', code }));
      return { ok: false, paid: 0 };
    }
    if (newBalance === null) {
      socket.send(JSON.stringify({
        type: 'room-error', reason: 'insufficient-balance', required: stake, code,
      }));
      return { ok: false, paid: 0 };
    }
    recordStakeCollected(stake).catch((err) => {
      console.error('Failed to record room-stake collection in house ledger:', err);
    });
    return { ok: true, paid: stake };
  }

  async function create(id, socket, callsign, userId = null, characterVariant = null, rawStake = 0) {
    leave(id); // defensive - see comment above
    // Only a non-negative whole number - anything else (missing, negative,
    // a string, NaN) becomes a free room rather than trusting client input.
    const stake = Number.isInteger(rawStake) && rawStake > 0 ? rawStake : 0;

    const { ok, paid } = await tryPayStake(socket, userId, stake, null);
    if (!ok) return;

    const code = generateCode();
    rooms.set(code, {
      hostId: id,
      stake,
      pool: paid,
      members: new Map([[id, {
        socket, callsign, userId, characterVariant, stakePaid: paid,
      }]]),
    });
    roomCodeByMemberId.set(id, code);
    socket.send(JSON.stringify({ type: 'room-created', code, hostId: id, stake }));
    broadcastRoomUpdate(code);
  }

  async function join(code, id, socket, callsign, userId = null, characterVariant = null) {
    const room = rooms.get(code);
    if (!room) {
      socket.send(JSON.stringify({ type: 'room-error', reason: 'not-found', code }));
      return;
    }
    if (room.members.size >= MAX_ROOM_SIZE) {
      socket.send(JSON.stringify({ type: 'room-error', reason: 'full', code }));
      return;
    }

    const { ok, paid } = await tryPayStake(socket, userId, room.stake, code);
    if (!ok) return;

    leave(id); // defensive - see comment above create() - after paying, so switching rooms mid-payment can't lose track of a charge
    room.pool += paid;
    room.members.set(id, {
      socket, callsign, userId, characterVariant, stakePaid: paid,
    });
    roomCodeByMemberId.set(id, code);
    broadcastRoomUpdate(code);
  }

  // Host-only - converts the room's current member list into a real match,
  // the exact same shape queue.js's tick() hands to onMatchStart, plus the
  // room's final pool total (0 for an unstaked room) so match.js can pay it
  // out to whoever wins - see its stake-pool payout logic. Anyone else
  // calling this is silently ignored (their client simply never gets a
  // match-start - the UI only shows the Start button to the host anyway).
  function start(code, requesterId) {
    const room = rooms.get(code);
    if (!room || room.hostId !== requesterId) return;

    const participants = Array.from(room.members.entries()).map(([id, member]) => ({
      id,
      socket: member.socket,
      callsign: member.callsign,
      userId: member.userId,
      characterVariant: member.characterVariant,
    }));
    const stakePool = room.pool;

    for (const id of room.members.keys()) roomCodeByMemberId.delete(id);
    rooms.delete(code);

    onMatchStart(participants, stakePool);
  }

  // Read-only snapshot for the admin dashboard's live stats (see
  // server/src/liveStats.js) - never used by any matchmaking logic itself.
  function getStats() {
    let waitingPlayers = 0;
    for (const room of rooms.values()) waitingPlayers += room.members.size;
    return { roomCount: rooms.size, waitingPlayers };
  }

  return {
    create, join, start, leave, getStats,
  };
}
