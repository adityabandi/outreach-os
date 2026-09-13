-- Outreach OS — initial schema (Postgres 18, uuidv7 ids)
-- Tenancy: every workspace-owned row carries organization_id + workspace_id.
-- RLS defense-in-depth: policies read current_setting('app.workspace_id', true).

create extension if not exists pgcrypto;

-- ---------- identity & tenancy ----------
create table organizations (
  id uuid primary key default uuidv7(),
  name text not null,
  status text not null default 'active',
  kill_switch boolean not null default false,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organizations(id),
  name text not null,
  slug text not null unique,
  domain text,
  default_timezone text not null default 'UTC',
  status text not null default 'active',
  kill_switch boolean not null default false,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default uuidv7(),
  auth_subject text unique,
  email text not null unique,
  display_name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table organization_memberships (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('org_owner')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table workspace_memberships (
  id uuid primary key default uuidv7(),
  workspace_id uuid not null references workspaces(id),
  user_id uuid not null references users(id),
  role text not null check (role in ('workspace_admin','campaign_operator','approver','analyst')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, role)
);

create table workspace_policies (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organizations(id),
  workspace_id uuid not null references workspaces(id),
  version int not null default 1,
  daily_send_cap int not null default 50,
  per_domain_cap int not null default 5,
  allowed_channels text[] not null default '{email}',
  reply_auto_send_policy jsonb not null default '{"mode":"off"}',
  retention_json jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- dev-only sessions (swapped for managed OIDC in production)
create table sessions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------- business configuration ----------
create table offers (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  description text not null default '',
  pricing_text text not null default '',
  call_to_action text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table ideal_customer_profiles (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  criteria_json jsonb not null default '{}',
  exclusions_json jsonb not null default '{}',
  territories text[] not null default '{}',
  languages text[] not null default '{}',
  status text not null default 'active'
);

create table approved_claims (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  claim_text text not null,
  evidence_url text,
  evidence_note text,
  valid_from timestamptz,
  valid_until timestamptz,
  status text not null default 'active',
  approved_by uuid references users(id)
);

create table sender_identities (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  channel text not null default 'email',
  display_name text not null,
  address text not null,
  provider_account_id text,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','pending','verified','failed')),
  daily_cap int not null default 25,
  status text not null default 'active',
  unique (workspace_id, address)
);

create table integrations (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  provider text not null,
  external_account_id text,
  encrypted_secret_ref text,
  scopes_json jsonb not null default '{}',
  status text not null default 'healthy',
  last_health_check_at timestamptz,
  unique (workspace_id, provider, external_account_id)
);

create table success_events (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  event_type text not null,
  provider text,
  mapping_json jsonb not null default '{}',
  status text not null default 'active'
);

-- ---------- prospects & evidence ----------
create table companies (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  normalized_domain text,
  website_url text,
  country text,
  industry text,
  size_band text,
  source_status text not null default 'imported',
  created_at timestamptz not null default now(),
  unique (workspace_id, normalized_domain)
);

create table people (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  company_id uuid references companies(id),
  full_name text not null,
  title text,
  location text,
  profile_url text,
  normalized_email text,
  created_at timestamptz not null default now(),
  unique (workspace_id, normalized_email)
);

create table contact_points (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  person_id uuid not null references people(id),
  type text not null default 'email',
  normalized_value text not null,
  verification_status text not null default 'unverified' check (verification_status in ('unverified','verified','risky','invalid')),
  verification_provider text,
  verified_at timestamptz,
  evidence_id uuid,
  do_not_contact boolean not null default false,
  unique (workspace_id, type, normalized_value)
);

create table prospect_lists (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  source_type text not null default 'csv',
  status text not null default 'active',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table prospect_list_members (
  id uuid primary key default uuidv7(),
  prospect_list_id uuid not null references prospect_lists(id),
  person_id uuid not null references people(id),
  added_at timestamptz not null default now(),
  unique (prospect_list_id, person_id)
);

create table evidence_items (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  subject_type text not null, -- person | company
  subject_id uuid not null,
  source_type text not null, -- csv | web | manual | provider
  source_url text,
  provider_ref text,
  observed_at timestamptz not null default now(),
  excerpt text not null,
  content_hash text not null,
  storage_ref text,
  status text not null default 'active'
);

create table qualification_runs (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  person_id uuid not null references people(id),
  icp_id uuid references ideal_customer_profiles(id),
  model_run_id uuid,
  score numeric(4,3),
  confidence numeric(4,3),
  disposition text not null default 'pending' check (disposition in ('qualified','research_queue','disqualified','pending')),
  reasons_json jsonb not null default '[]',
  disqualifiers_json jsonb not null default '[]',
  evidence_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create table dedupe_candidates (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  left_person_id uuid not null references people(id),
  right_person_id uuid not null references people(id),
  confidence numeric(4,3),
  reasons_json jsonb not null default '[]',
  resolution text check (resolution in ('merged','distinct')),
  resolved_by uuid references users(id),
  resolved_at timestamptz
);

-- ---------- AI & content ----------
create table prompt_versions (
  id uuid primary key default uuidv7(),
  task_type text not null,
  version int not null,
  template_hash text not null,
  schema_version text not null default '1',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (task_type, version)
);

create table model_runs (
  id uuid primary key default uuidv7(),
  organization_id uuid,
  workspace_id uuid,
  task_type text not null,
  provider text not null,
  model text not null,
  prompt_version_id uuid,
  input_hash text not null,
  output_json jsonb not null default '{}',
  validation_status text not null default 'valid',
  token_usage_json jsonb not null default '{}',
  cost_amount numeric(10,6),
  latency_ms int,
  created_at timestamptz not null default now()
);

create table research_notes (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  person_id uuid not null references people(id),
  summary text not null,
  evidence_ids uuid[] not null default '{}',
  confidence numeric(4,3),
  warnings_json jsonb not null default '[]',
  model_run_id uuid,
  created_at timestamptz not null default now()
);

create table sequence_templates (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  channel text not null default 'email',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table sequence_steps (
  id uuid primary key default uuidv7(),
  template_id uuid not null references sequence_templates(id) on delete cascade,
  step_number int not null,
  delay_minutes int not null default 0,
  subject_template text not null default '',
  body_template text not null,
  stop_conditions_json jsonb not null default '["reply","bounce","unsubscribe","conversion"]',
  unique (template_id, step_number)
);

create table personalizations (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  person_id uuid not null references people(id),
  campaign_version_id uuid,
  rendered_steps_json jsonb not null default '[]',
  evidence_ids uuid[] not null default '{}',
  warnings_json jsonb not null default '[]',
  model_run_id uuid,
  review_status text not null default 'draft',
  created_at timestamptz not null default now()
);

-- ---------- campaigns, approval, delivery ----------
create table campaigns (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  name text not null,
  offer_id uuid references offers(id),
  icp_id uuid references ideal_customer_profiles(id),
  status text not null default 'draft',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table campaign_versions (
  id uuid primary key default uuidv7(),
  campaign_id uuid not null references campaigns(id),
  version_number int not null,
  source_version_id uuid,
  payload_json jsonb not null default '{}',
  payload_hash text,
  status text not null default 'draft',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (campaign_id, version_number)
);

create table campaign_version_recipients (
  id uuid primary key default uuidv7(),
  campaign_version_id uuid not null references campaign_versions(id) on delete cascade,
  person_id uuid not null references people(id),
  contact_point_id uuid not null references contact_points(id),
  personalization_id uuid references personalizations(id),
  exclusion_reason text,
  unique (campaign_version_id, person_id)
);

create table approval_requests (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  resource_type text not null, -- campaign_version | reply_draft
  resource_id uuid not null,
  payload_hash text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','superseded')),
  requested_by uuid references users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text
);

create table campaign_runs (
  id uuid primary key default uuidv7(),
  campaign_version_id uuid not null references campaign_versions(id),
  status text not null default 'scheduled' check (status in ('scheduled','running','paused','stopped','completed','failed')),
  launched_by uuid references users(id),
  launched_at timestamptz,
  paused_by uuid references users(id),
  paused_at timestamptz,
  stop_reason text
);

create table message_deliveries (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  campaign_run_id uuid references campaign_runs(id),
  campaign_version_id uuid not null references campaign_versions(id),
  person_id uuid not null references people(id),
  contact_point_id uuid references contact_points(id),
  sequence_step_id uuid references sequence_steps(id),
  step_number int not null default 1,
  sender_identity_id uuid references sender_identities(id),
  subject_rendered text,
  body_rendered text,
  provider_message_id text,
  idempotency_key text not null,
  scheduled_at timestamptz,
  sent_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','sending','sent','failed','skipped','suppressed')),
  error_code text,
  thread_ref text,
  unique (idempotency_key)
);

create table delivery_events (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  message_delivery_id uuid not null references message_deliveries(id),
  provider_event_id text,
  type text not null, -- queued|sent|delivered|bounced|failed|opened|clicked|unsubscribed
  occurred_at timestamptz not null default now(),
  payload_ref text,
  unique (workspace_id, provider_event_id)
);

create table suppression_entries (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  scope text not null default 'workspace', -- workspace | domain | global
  normalized_value text not null,
  reason text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (workspace_id, scope, normalized_value)
);

-- dev "test mailbox" adapter outbox
create table outbox_messages (
  id uuid primary key default uuidv7(),
  workspace_id uuid not null,
  message_delivery_id uuid references message_deliveries(id),
  from_address text not null,
  to_address text not null,
  subject text not null,
  body text not null,
  provider_message_id text not null,
  thread_ref text,
  created_at timestamptz not null default now()
);

-- ---------- replies & conversions ----------
create table inbound_messages (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  provider_message_id text not null,
  thread_ref text,
  sender_contact text,
  person_id uuid references people(id),
  received_at timestamptz not null default now(),
  subject text,
  body text not null,
  raw_event_ref text,
  unique (workspace_id, provider_message_id)
);

create table reply_classifications (
  id uuid primary key default uuidv7(),
  inbound_message_id uuid not null references inbound_messages(id),
  category text not null check (category in ('interested','question','objection','not_now','unsubscribe','wrong_person','out_of_office','complaint','negotiation','other')),
  confidence numeric(4,3),
  extracted_json jsonb not null default '{}',
  model_run_id uuid,
  review_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table reply_drafts (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  inbound_message_id uuid not null references inbound_messages(id),
  body text not null,
  policy_class text not null default 'sensitive' check (policy_class in ('routine','sensitive')),
  model_run_id uuid,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','sent','discarded')),
  approval_request_id uuid,
  sent_delivery_id uuid
);

create table conversions (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  person_id uuid references people(id),
  campaign_id uuid references campaigns(id),
  message_delivery_id uuid references message_deliveries(id),
  event_type text not null, -- meeting|signup|revenue
  external_ref text,
  value_amount numeric(12,2),
  currency text,
  occurred_at timestamptz not null default now(),
  attribution_json jsonb not null default '{}'
);

-- ---------- operations & audit ----------
create table provider_webhook_events (
  id uuid primary key default uuidv7(),
  provider text not null,
  external_event_id text not null,
  organization_id uuid,
  workspace_id uuid,
  received_at timestamptz not null default now(),
  signature_valid boolean not null default false,
  payload_json jsonb not null default '{}',
  processing_status text not null default 'pending',
  unique (provider, external_event_id)
);

create table job_runs (
  id uuid primary key default uuidv7(),
  organization_id uuid,
  workspace_id uuid,
  job_type text not null,
  idempotency_key text not null unique,
  payload_json jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text
);
create index job_runs_pick on job_runs (status, scheduled_at) where status in ('queued','failed');

create table audit_events (
  id uuid primary key default uuidv7(),
  organization_id uuid,
  workspace_id uuid,
  actor_type text not null, -- user | system | worker | webhook
  actor_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  request_id text,
  metadata_json jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index audit_ws_ts on audit_events (workspace_id, occurred_at desc);

-- immutability: approved+ campaign versions cannot change
create or replace function reject_version_mutation() returns trigger as $$
begin
  if old.status in ('approval_pending','approved','scheduled','running','paused','completed') then
    if new.payload_json is distinct from old.payload_json or new.payload_hash is distinct from old.payload_hash then
      raise exception 'campaign version % is immutable in status %', old.id, old.status;
    end if;
  end if;
  return new;
end $$ language plpgsql;

create trigger campaign_versions_immutable
before update on campaign_versions
for each row execute function reject_version_mutation();

-- ---------- row-level security (defense in depth) ----------
-- app.workspace_id (GUC) is set per transaction by the data layer.
create or replace function current_ws() returns uuid language sql stable as
$$ select nullif(current_setting('app.workspace_id', true), '')::uuid $$;

do $$
declare t text;
begin
  foreach t in array array[
    'workspace_policies','offers','ideal_customer_profiles','approved_claims',
    'sender_identities','integrations','success_events','companies','people',
    'contact_points','prospect_lists','evidence_items','qualification_runs',
    'dedupe_candidates','research_notes','sequence_templates','personalizations',
    'campaigns','approval_requests','message_deliveries','delivery_events',
    'suppression_entries','inbound_messages','reply_drafts','conversions',
    'audit_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I on %I using (workspace_id = current_ws()) with check (workspace_id = current_ws())',
      t || '_tenant', t);
  end loop;
end $$;
