export type EventSeq = { last_ms: number; counter: number };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function formatUuid(hex16: string): string {
  return `${hex16.slice(0, 8)}-${hex16.slice(8, 12)}-${hex16.slice(12, 16)}-${hex16.slice(16, 20)}-${hex16.slice(20, 32)}`;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/** Random-tail UUIDv7 (for entity IDs). Lexicographically sortable by time. */
export function uuidv7(nowMs: number = Date.now()): string {
  const ms = BigInt(nowMs);
  const msHex = ms.toString(16).padStart(12, "0"); // 48 bits
  const rand = randomBytes(10); // 80 bits
  // version: top nibble of 12th byte (index 6 of the 16-byte array) → 0x7
  rand[0]! = (rand[0]! & 0x0f) | 0x70;
  // variant: top 2 bits of 8th byte (index 8) → 0b10
  rand[2]! = (rand[2]! & 0x3f) | 0x80;
  const randHex = bytesToHex(rand);
  return formatUuid(msHex + randHex);
}

/**
 * Monotonic UUIDv7 for per-channel event_id. Counter occupies rand_a (12 bits).
 * Same DO, same ms → counter increments → strictly increasing. Cross-ms → counter resets.
 * Returns the new id AND the updated seq (caller persists atomically in the same txn).
 */
export function monotonicUuidV7(seq: EventSeq, nowMs: number = Date.now()): { id: string; seq: EventSeq } {
  let ms = seq.last_ms;
  let counter = seq.counter;
  if (nowMs > ms) {
    ms = nowMs;
    counter = 0;
  } else {
    counter = (counter + 1) & 0xfff; // 12-bit wrap (should not happen in practice)
  }
  const msHex = BigInt(ms).toString(16).padStart(12, "0");
  // rand_a (12 bits) = counter, with version nibble 7 in the high nibble of byte 6.
  // byte 6 high nibble = 7, low nibble = counter>>8 ; byte 7 = counter & 0xff
  const counterHigh = (counter >> 8) & 0x0f;
  const counterLow = counter & 0xff;
  const randB = randomBytes(8); // 64 bits rand_b
  // variant bits on rand_b[0]
  randB[0]! = (randB[0]! & 0x3f) | 0x80;
  const hex =
    msHex +
    "7" + counterHigh.toString(16) + counterLow.toString(16).padStart(2, "0") +
    bytesToHex(randB);
  return { id: formatUuid(hex), seq: { last_ms: ms, counter } };
}
