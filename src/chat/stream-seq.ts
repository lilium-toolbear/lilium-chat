import { sha256Hex } from "./command-options";

export type AppendSeqValidation =
  | { kind: "durable_noop" }
  | { kind: "accept" }
  | { kind: "unacked_duplicate" }
  | { kind: "sequence_gap" };

/** Seq rules for append hot path (spec §8). Gap uses received_seq + 1, not ack_seq + 1. */
export function validateAppendSeq(input: {
  seq: number;
  ackSeq: number;
  receivedSeq: number;
}): AppendSeqValidation {
  if (input.seq <= input.ackSeq) return { kind: "durable_noop" };
  if (input.seq > input.receivedSeq + 1) return { kind: "sequence_gap" };
  if (input.seq <= input.receivedSeq) return { kind: "unacked_duplicate" };
  return { kind: "accept" };
}

export function hashStreamDelta(delta: string): Promise<string> {
  return sha256Hex(delta);
}
