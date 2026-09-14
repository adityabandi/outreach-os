// One-click unsubscribe tokens: HMAC-signed, workspace + recipient bound,
// URL-safe, and cheap to verify without a database lookup.
import { createHmac } from "node:crypto";

const SECRET = () => process.env.UNSUB_SECRET || process.env.SESSION_SECRET || "dev-only-secret-change-me";

export function unsubToken(workspaceId: string, contactPointId: string, email: string): string {
  const payload = `${workspaceId}.${contactPointId}.${email.toLowerCase()}`;
  const sig = createHmac("sha256", SECRET()).update(payload).digest("base64url");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verifyUnsubToken(token: string): { workspaceId: string; contactPointId: string; email: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const raw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payload: string;
  try { payload = Buffer.from(raw, "base64url").toString("utf8"); } catch { return null; }
  // ids are dot-free uuids; the email keeps its own dots
  const first = payload.indexOf(".");
  const second = payload.indexOf(".", first + 1);
  if (first <= 0 || second <= first + 1 || second === payload.length - 1) return null;
  const workspaceId = payload.slice(0, first);
  const contactPointId = payload.slice(first + 1, second);
  const email = payload.slice(second + 1);
  const expect = createHmac("sha256", SECRET()).update(payload).digest("base64url");
  return expect === sig ? { workspaceId, contactPointId, email } : null;
}

export function unsubUrl(baseUrl: string, workspaceId: string, contactPointId: string, email: string): string {
  return `${baseUrl.replace(/\/$/, "")}/u/${unsubToken(workspaceId, contactPointId, email)}`;
}
