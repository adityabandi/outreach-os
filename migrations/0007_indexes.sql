-- Hot-path indexes: worker pick, run progress, analytics joins, caps, outbox.
create index if not exists md_pick on message_deliveries (status, scheduled_at) where status = 'scheduled';
create index if not exists md_version on message_deliveries (campaign_version_id);
create index if not exists md_run on message_deliveries (campaign_run_id, status);
create index if not exists md_ws_sent on message_deliveries (workspace_id, sent_at) where sent_at is not null;
create index if not exists md_sender_day on message_deliveries (sender_identity_id, sent_at) where sent_at is not null;
create index if not exists inbound_thread on inbound_messages (thread_ref);
create index if not exists inbound_person on inbound_messages (person_id);
create index if not exists cv_campaign on campaign_versions (campaign_id);
create index if not exists cvr_version on campaign_version_recipients (campaign_version_id);
create index if not exists cp_person on contact_points (person_id);
create index if not exists de_delivery on delivery_events (message_delivery_id);
create index if not exists outbox_ws_ts on outbox_messages (workspace_id, created_at desc);
create index if not exists approvals_status on approval_requests (status) where status = 'pending';
create index if not exists suppression_value on suppression_entries (normalized_value);
