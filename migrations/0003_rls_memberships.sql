-- workspace_memberships carries workspace_id and must be tenant-scoped too.
alter table workspace_memberships enable row level security;
alter table workspace_memberships force row level security;
create policy workspace_memberships_tenant on workspace_memberships
  using (workspace_id = current_ws()) with check (workspace_id = current_ws());
-- identity path exception: requireWorkspace() runs as the app role BEFORE the GUC is set
-- for the membership lookup itself, so the lookup goes through a security definer function.
create or replace function my_memberships(p_user uuid)
returns table (workspace_id uuid, role text)
language sql security definer stable
set row_security = off as
$$ select workspace_id, role from workspace_memberships where user_id = p_user $$;
