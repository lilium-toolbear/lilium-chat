const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidString(value: string): boolean {
  return UUID_RE.test(value);
}

export function canonicalDmPairKey(userA: string, userB: string): {
  pair_key: string;
  user_low: string;
  user_high: string;
} {
  if (userA === userB) {
    throw new Error("DM pair requires two distinct user ids");
  }
  const user_low = userA < userB ? userA : userB;
  const user_high = userA < userB ? userB : userA;
  return { pair_key: `${user_low}:${user_high}`, user_low, user_high };
}
