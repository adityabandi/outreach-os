-- Webhook ingress maps a provider account to its workspace before tenancy exists.
create or replace function lookup_integration(p_provider text, p_external_account_id text)
returns table (workspace_id uuid, organization_id uuid)
language sql security definer stable
set row_security = off as
$$ select workspace_id, organization_id from integrations
    where provider = p_provider and external_account_id = p_external_account_id limit 1 $$;
