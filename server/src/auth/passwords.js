import bcrypt from 'bcrypt';

// 12 rounds is a reasonable modern default - high enough to be slow for an
// attacker brute-forcing offline, not so high it noticeably slows login.
const SALT_ROUNDS = 12;

// bcrypt generates and stores a random salt as part of the hash itself
// (that's why hashPassword needs no separate salt parameter) - this is why
// two users with the same password get different hashes.
export function hashPassword(plainTextPassword) {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export function verifyPassword(plainTextPassword, storedHash) {
  return bcrypt.compare(plainTextPassword, storedHash);
}
