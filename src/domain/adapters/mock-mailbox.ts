// Test mailbox adapter (spec M4 first adapter): records sends to the outbox
// table instead of a real provider. Deterministic provider ids, replay-safe.
import type { Db } from "@/db/client";
import type { MailboxAdapter, SendInput, SendResult } from "./types";

export class MockMailboxAdapter implements MailboxAdapter {
  provider = "mock-mailbox";
  constructor(private db: Db, private workspaceId: string) {}

  async validateSender(address: string) {
    return address.includes("@")
      ? { ok: true }
      : { ok: false, reason: "malformed sender address" };
  }

  async send(input: SendInput): Promise<SendResult> {
    const providerMessageId = `mock_${input.idempotencyKey.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`;
    const threadRef = input.threadRef ?? `thr_${providerMessageId}`;
    await this.db.query(
      `insert into outbox_messages
         (workspace_id, from_address, to_address, subject, body, provider_message_id, thread_ref)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing`,
      [this.workspaceId, input.fromAddress, input.toAddress, input.subject, input.body, providerMessageId, threadRef],
    );
    return { providerMessageId, threadRef };
  }
}
