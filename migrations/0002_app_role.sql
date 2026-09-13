-- Runtime role: the app never connects as superuser, so RLS policies bind.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'outreach_app') then
    create role outreach_app login password 'outreach_app';
  end if;
end $$;
grant usage on schema public to outreach_app;
grant select, insert, update, delete on all tables in schema public to outreach_app;
alter default privileges in schema public grant select, insert, update, delete on tables to outreach_app;
-- sessions/users/workspaces/organizations stay RLS-free (identity lookup predates tenancy);
-- all workspace-owned tables are RLS-protected and require the app.workspace_id GUC.
