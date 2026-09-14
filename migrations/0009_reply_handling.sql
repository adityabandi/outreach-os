-- Warm-reply attention state: a classified warm reply stays "waiting" until a
-- human marks it handled.
alter table inbound_messages add column if not exists handled_at timestamptz;
alter table inbound_messages add column if not exists handled_by uuid;
create index if not exists inbound_unhandled on inbound_messages (workspace_id, received_at desc) where handled_at is null;
