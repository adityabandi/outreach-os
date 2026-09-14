// Adapter resolution: a workspace sends through Gmail when it has a healthy,
// fully-configured gmail integration; otherwise it falls back to the dev
// mock-mailbox (outbox table). Delivery and sender-verification both resolve
// through here, so turning on real sending is config, not code.
import type { Db } from "@/db/client";
import { GmailMailboxAdapter, tokensFromEnv } from "./gmail-mailbox";
import { MockMailboxAdapter } from "./mock-mailbox";
import type { MailboxAdapter } from "./types";

export interface IntegrationRow { provider: string; status: string; encrypted_secret_ref: string | null }

export type MailboxChoice = { kind: "gmail"; secretRef: string } | { kind: "mock" };

export function chooseMailbox(integrations: IntegrationRow[]): MailboxChoice {
  const gmail = integrations.find(
    (i) => i.provider === "gmail" && i.status === "healthy" && i.encrypted_secret_ref,
  );
  return gmail ? { kind: "gmail", secretRef: gmail.encrypted_secret_ref! } : { kind: "mock" };
}

export async function resolveMailboxAdapter(db: Db, workspaceId: string): Promise<MailboxAdapter> {
  const rows = await db.query(
    `select provider, status, encrypted_secret_ref from integrations where workspace_id = $1`,
    [workspaceId],
  );
  const choice = chooseMailbox(rows.rows);
  if (choice.kind === "gmail") {
    const tokens = tokensFromEnv(choice.secretRef);
    if (tokens) return new GmailMailboxAdapter(tokens);
    // misconfigured gmail must never silently become a mock send - fall back
    // only when no gmail integration exists at all
    throw new Error(`gmail integration configured but env tokens are missing (${choice.secretRef})`);
  }
  return new MockMailboxAdapter(db, workspaceId);
}
