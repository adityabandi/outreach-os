-- Per-row import outcome report, stored on the prospect list.
alter table prospect_lists add column if not exists import_report_json jsonb;
