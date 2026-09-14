-- Sender identity verification flow: emailed one-time code, hashed at rest,
-- 24h expiry, plus verified_at audit timestamp and creator tracking.
alter table sender_identities
  add column if not exists verification_token_hash text,
  add column if not exists verification_expires_at timestamptz,
  add column if not exists verification_sent_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists created_by uuid references users(id);
