-- Discount/referral codes that tie an external signup (Rewardful, Stripe) back
-- to the person and campaign that sourced it.
create table if not exists conversion_codes (
  id uuid primary key default uuidv7(),
  organization_id uuid not null,
  workspace_id uuid not null references workspaces(id),
  normalized_code text not null,
  display_code text not null,
  person_id uuid not null references people(id),
  campaign_id uuid references campaigns(id),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (workspace_id, normalized_code)
);
alter table conversion_codes enable row level security;
alter table conversion_codes force row level security;
create policy conversion_codes_tenant on conversion_codes
  using (workspace_id = current_ws()) with check (workspace_id = current_ws());

-- webhook dedupe: one conversion per external event reference per workspace
create unique index if not exists conversions_external_ref
  on conversions (workspace_id, external_ref) where external_ref is not null;
create index if not exists conversions_person on conversions (person_id, occurred_at desc);
