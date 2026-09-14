// Sender identity verification: pure rules, DB-free and unit-tested.
// A sender proves control of an address by entering a 6-digit code that the
// workspace mailbox sends to that address. Only the sha256 of the code is
// stored; codes expire after 24 hours.
import { createHash, randomInt } from "node:crypto";

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function isValidEmail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/** Six digits, zero-padded. Injectable randomness for deterministic tests. */
export function generateVerificationCode(rand: () => number = () => randomInt(0, 1_000_000)): string {
  return String(rand() % 1_000_000).padStart(6, "0");
}

export function hashVerificationCode(code: string): string {
  return createHash("sha256").update(`sender-verify:${code.trim()}`).digest("hex");
}

export type VerificationCheck = "ok" | "no_request" | "expired" | "mismatch";

export function checkVerificationCode(
  request: { tokenHash: string | null; expiresAt: Date | null },
  code: string,
  now: Date = new Date(),
): VerificationCheck {
  if (!request.tokenHash || !request.expiresAt) return "no_request";
  if (request.expiresAt.getTime() <= now.getTime()) return "expired";
  return hashVerificationCode(code) === request.tokenHash ? "ok" : "mismatch";
}
