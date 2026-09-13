# Tenant-aware AI Outreach MVP Specification

## 1. Product decision and build gate

**Approved product shape:** internal-first, tenant-aware from day one. The first release is operated by Aditya's team for multiple businesses. It does not include public self-service signup, billing, or customer support tooling, but all business data and credentials are isolated by tenant/workspace so the same core can later become SaaS.

**Still open before implementation starts:**
- Existing repository versus a new repository, including repo URL and target branch.
- Stack confirmation. Proposed default: Next.js + TypeScript, Postgres, a durable job queue, object storage, and provider adapters.
- Initial sending provider(s), inbox provider(s), prospect data sources, and hosting environment. Provider choices should not change the domain model.

No campaign may send until an authorized human approves one immutable campaign version containing the sender, audience, copy, timing, follow-up rules, channel, and limits.

## 2. MVP goals and non-goals

### Goals
1. Configure several business workspaces, offers, ideal-customer profiles, approved claims, exclusions, sender identities, and success events.
2. Discover or import prospects, deduplicate them, retain source evidence, qualify them, and verify the actual contact route.
3. Generate evidence-backed personalization and an outreach sequence without inventing facts.
4. Review and approve a locked campaign version.
5. Send capped batches, schedule approved follow-ups, pause instantly, and enforce bounce/unsubscribe/suppression rules.
6. Ingest replies, classify them, and draft responses for review.
7. Track meetings, signups, and revenue back to campaigns and prospects.
8. Keep an append-only audit trail for material actions and approval decisions.

### Non-goals for internal v1
- Public self-service tenant creation or subscription billing.
- Fully autonomous cold-campaign launch.
- Autonomous pricing exceptions, negotiation, promises, legal claims, or sensitive replies.
- A general CRM replacement.
- Social-channel automation that violates provider rules or requires brittle browser scraping.
- Automatic contact guessing represented as verification.

## 3. Proposed architecture

### Default stack
- **Web/API:** Next.js App Router, TypeScript.
- **Database:** Postgres with migrations; UUIDv7 or ULID primary keys.
- **Jobs:** durable queue with retries, idempotency, scheduled jobs, dead-letter handling, and per-tenant concurrency. Good implementations include Trigger.dev, Temporal, Inngest, or BullMQ backed by managed Redis. Select one after the hosting decision.
- **Storage:** S3-compatible object storage for imports, exports, and retained evidence snapshots where permitted.
- **Authentication:** managed OIDC/session provider, with application-owned membership and role tables.
- **AI:** provider-neutral model adapter, structured JSON outputs validated with Zod, prompt/version registry, cost and latency logs.
- **Observability:** structured logs, traces, error reporting, job dashboard, and provider webhook logs.

### Services/modules
Keep a modular monolith for v1, with queue workers sharing the domain package:
- Identity and tenancy
- Workspace configuration
- Prospecting and evidence
- Qualification and contact verification
- Sequence/personalization
- Campaign versioning and approvals
- Delivery and follow-ups
- Reply ingestion and triage
- Suppression/compliance
- Conversion tracking and analytics
- Audit/event log
- Provider adapters

Split services only when load or team boundaries justify it.

### Provider boundaries
Every external system sits behind an interface and stores its own provider reference:
- `ProspectSourceAdapter.search/import/readEvidence`
- `ContactVerificationAdapter.verify`
- `MailboxAdapter.validateSender/send/getThread/subscribeReplies`
- `ModelAdapter.generateStructured`
- `CalendarOrCRMAdapter.recordConversion`
- `Payout/affiliate` is explicitly outside this outreach MVP.

Webhook handlers authenticate the provider, persist the raw event, deduplicate by provider event ID, then enqueue domain processing. They do not perform long-running work inline.

## 4. Tenancy and security model

### Tenant hierarchy
- `organization`: future SaaS customer boundary. In internal v1, one organization can own all of Aditya's workspaces.
- `workspace`: one business/brand and its isolated prospects, senders, campaigns, credentials, policies, and analytics.
- Users receive organization membership plus explicit workspace access.

### Roles
- **org_owner:** manages organization and memberships.
- **workspace_admin:** configures one workspace, integrations, policies, and approvers.
- **campaign_operator:** researches, imports, drafts, and pauses campaigns.
- **approver:** approves or rejects immutable campaign versions and sensitive reply drafts.
- **analyst:** read-only access to campaigns and reporting.

A user may hold multiple roles. Authorization is checked server-side on every command and query.

### Isolation rules
1. Every workspace-owned table includes `organization_id` and `workspace_id` where applicable.
2. Every database query receives tenancy from the authenticated server context, never from a trusted client parameter alone.
3. Enable Postgres row-level security as defense in depth; application tests must prove cross-workspace reads and writes fail.
4. Unique constraints include tenant scope, for example `(workspace_id, normalized_email)`.
5. Queue payloads contain tenant and resource IDs, but workers re-authorize/reload them rather than trusting serialized objects.
6. Cache keys, object-storage paths, analytics events, logs, and idempotency keys are tenant-prefixed.
7. Secrets are encrypted with a managed KMS/envelope key and referenced by secret ID. Never expose provider tokens to the browser or logs.
8. Provider webhooks map credentials and external account IDs to exactly one workspace.
9. Audit records are append-only and include actor, tenant, action, target, request ID, timestamp, and redacted before/after metadata.
10. Deletion/export is workspace-scoped. Suppression records are retained as required to prevent accidental re-contact.

### Data handling
- Store only prospect data needed for the campaign.
- Attach provenance: source URL/provider, observed time, exact evidence excerpt or permitted snapshot, and verification status.
- Maintain configurable retention for raw research, message bodies, AI inputs/outputs, and webhook payloads.
- Redact secrets and unnecessary personal data from prompts and logs.
- Treat imported text and web content as untrusted data; it can inform prospect facts but cannot issue system instructions or authorize actions.

## 5. Core data schema

Names are illustrative; migrations are authoritative. All timestamps are timezone-aware.

### Identity and tenancy
- `organizations(id, name, status, created_at)`
- `workspaces(id, organization_id, name, slug, domain, default_timezone, status, created_at)`
- `users(id, auth_subject, email, display_name, status, created_at)`
- `organization_memberships(id, organization_id, user_id, role, created_at)`
- `workspace_memberships(id, workspace_id, user_id, role, created_at)`
- `workspace_policies(id, workspace_id, version, daily_send_cap, per_domain_cap, allowed_channels, reply_auto_send_policy, retention_json, created_by, created_at)`

### Business configuration
- `offers(id, workspace_id, name, description, pricing_text, call_to_action, status, created_at)`
- `ideal_customer_profiles(id, workspace_id, name, criteria_json, exclusions_json, territories, languages, status)`
- `approved_claims(id, workspace_id, claim_text, evidence_url, evidence_note, valid_from, valid_until, status, approved_by)`
- `sender_identities(id, workspace_id, channel, display_name, address, provider_account_id, verification_status, daily_cap, status)`
- `integrations(id, workspace_id, provider, external_account_id, encrypted_secret_ref, scopes_json, status, last_health_check_at)`
- `success_events(id, workspace_id, name, event_type, provider, mapping_json, status)`

### Prospects and evidence
- `companies(id, workspace_id, name, normalized_domain, website_url, country, industry, size_band, source_status, created_at)`
- `people(id, workspace_id, company_id, full_name, title, location, profile_url, created_at)`
- `contact_points(id, workspace_id, person_id, type, normalized_value, verification_status, verification_provider, verified_at, evidence_id, do_not_contact)`
- `prospect_lists(id, workspace_id, name, source_type, status, created_by, created_at)`
- `prospect_list_members(id, prospect_list_id, person_id, added_at, unique(prospect_list_id, person_id))`
- `evidence_items(id, workspace_id, subject_type, subject_id, source_type, source_url, provider_ref, observed_at, excerpt, content_hash, storage_ref, status)`
- `qualification_runs(id, workspace_id, person_id, icp_id, model_run_id, score, confidence, disposition, reasons_json, disqualifiers_json, evidence_ids, created_at)`
- `dedupe_candidates(id, workspace_id, left_person_id, right_person_id, confidence, reasons_json, resolution, resolved_by, resolved_at)`

### AI and content
- `prompt_versions(id, task_type, version, template_hash, schema_version, status, created_at)`
- `model_runs(id, workspace_id, task_type, provider, model, prompt_version_id, input_hash, output_json, validation_status, token_usage_json, cost_amount, latency_ms, created_at)`
- `research_notes(id, workspace_id, person_id, summary, evidence_ids, confidence, warnings_json, model_run_id, created_at)`
- `sequence_templates(id, workspace_id, name, channel, status, created_at)`
- `sequence_steps(id, template_id, step_number, delay_minutes, subject_template, body_template, stop_conditions_json)`
- `personalizations(id, workspace_id, person_id, campaign_version_id, rendered_steps_json, evidence_ids, warnings_json, model_run_id, review_status)`

### Campaigns, approval, and delivery
- `campaigns(id, workspace_id, name, offer_id, icp_id, status, created_by, created_at)`
- `campaign_versions(id, campaign_id, version_number, source_version_id, immutable_payload_json, payload_hash, status, created_by, created_at)`
- `campaign_version_recipients(id, campaign_version_id, person_id, contact_point_id, personalization_id, exclusion_reason, unique(campaign_version_id, person_id))`
- `approval_requests(id, workspace_id, resource_type, resource_id, payload_hash, status, requested_by, requested_at, decided_by, decided_at, decision_note)`
- `campaign_runs(id, campaign_version_id, status, launched_by, launched_at, paused_by, paused_at, stop_reason)`
- `message_deliveries(id, workspace_id, campaign_run_id, campaign_version_id, person_id, sequence_step_id, sender_identity_id, provider_message_id, idempotency_key, scheduled_at, sent_at, status, error_code, thread_ref)`
- `delivery_events(id, workspace_id, message_delivery_id, provider_event_id, type, occurred_at, payload_ref)`
- `suppression_entries(id, workspace_id, scope, normalized_value, reason, source, created_at, expires_at)`

### Replies and conversions
- `inbound_messages(id, workspace_id, provider_message_id, thread_ref, sender_contact, received_at, subject, body_ref, raw_event_ref, unique(workspace_id, provider_message_id))`
- `reply_classifications(id, inbound_message_id, category, confidence, extracted_json, model_run_id, review_status, created_at)`
- `reply_drafts(id, workspace_id, inbound_message_id, body, policy_class, model_run_id, status, approval_request_id, sent_delivery_id)`
- `conversions(id, workspace_id, person_id, campaign_id, message_delivery_id, event_type, external_ref, value_amount, currency, occurred_at, attribution_json)`

### Operations and audit
- `provider_webhook_events(id, provider, external_event_id, workspace_id, received_at, signature_valid, payload_ref, processing_status, unique(provider, external_event_id))`
- `job_runs(id, workspace_id, job_type, idempotency_key, status, attempts, scheduled_at, started_at, completed_at, last_error)`
- `audit_events(id, organization_id, workspace_id, actor_type, actor_id, action, target_type, target_id, request_id, metadata_json, occurred_at)`

### Important constraints
- Published campaign versions are immutable at the database and service layers.
- `payload_hash` is recomputed at approval and launch. Launch fails if it differs from the approved hash.
- A delivery references one approved campaign version and one exact recipient/contact point.
- `idempotency_key` is unique for each recipient, version, and sequence step.
- A suppression check occurs at scheduling and again immediately before send.
- Provider event IDs are unique and webhook processing is replay-safe.

## 6. Campaign approval state machine

### Campaign/version states
`DRAFT -> READY_FOR_REVIEW -> APPROVAL_PENDING -> APPROVED -> SCHEDULED -> RUNNING -> PAUSED -> COMPLETED`

Alternate terminal paths:
- `READY_FOR_REVIEW | APPROVAL_PENDING -> REJECTED`
- Any pre-run state -> `CANCELLED`
- `RUNNING | PAUSED -> STOPPED`
- Operational failure may set `FAILED`, but never silently resumes without policy-defined retry or operator action.

### Transition rules
- **DRAFT:** research, recipients, copy, and policies may change.
- **READY_FOR_REVIEW:** validation passes: sender verified, recipients resolved, evidence present, contact points verified, claims approved, schedule valid, caps set, suppression check clean.
- **APPROVAL_PENDING:** system snapshots one canonical immutable payload and hash. Changes require a new version.
- **APPROVED:** an authorized approver accepted the exact hash. Approval records actor and timestamp.
- **SCHEDULED/RUNNING:** launch service rechecks membership, sender/integration health, approved hash, suppressions, caps, and schedule before enqueuing.
- **PAUSED:** no unsent job may send. Already accepted provider sends cannot be recalled. Resume requires operator permission and revalidation.
- **COMPLETED:** all recipients have stopped, finished, replied, converted, bounced, or been suppressed.

### Immutable approval payload
At minimum:
- Workspace and campaign IDs
- Sender identity and sending account
- Channel
- Offer and allowed claims, with versions
- Exact recipient list or a frozen recipient manifest
- Exact templates and allowed personalization variables
- Rendered preview samples and personalization rules
- Sequence delays and stop conditions
- Delivery timezone/window
- Daily, sender, workspace, and domain caps
- Follow-up behavior
- Reply policy
- Suppression policy
- Payload schema version and hash

### Reply policy
- Auto-classification is allowed.
- Drafting is allowed.
- Auto-send defaults to **off**.
- Unsubscribe acknowledgement may be policy-driven, but suppression must happen immediately even if no response is sent.
- Interested, objection, negotiation, pricing, legal, sensitive, complaint, and low-confidence replies require human review.
- A future workspace policy may allow narrow routine replies, but each allowed category, template, variables, sender, and limits must be explicitly approved and versioned.

## 7. Domain workflows

### A. Workspace setup
1. Create workspace.
2. Configure offer, ICP, exclusions, territories, approved claims, CTA, timezone, and success events.
3. Connect and verify sender identity.
4. Set caps, delivery windows, retention, and approvers.
5. Health check blocks campaign readiness if any required integration is unhealthy.

### B. Prospect acquisition
1. Import CSV/CRM records or run an approved source adapter.
2. Normalize domains, names, and contact values.
3. Deduplicate deterministically, then create review items for probabilistic matches.
4. Save evidence and observed time.
5. Never convert inferred contact details into `verified` status.

### C. Qualification
1. Evaluate deterministic exclusions first.
2. Run structured AI scoring against one ICP version.
3. Require cited evidence for each positive fit reason.
4. Route low-confidence or conflicting records to a research queue.
5. Only qualified prospects with an allowed verified route enter campaign review.

### D. Personalization
1. Build a research packet from approved evidence only.
2. Generate structured output: opening, reason for fit, sequence copy, cited evidence IDs, confidence, warnings.
3. Reject unsupported claims, forbidden content, missing citations, and variables that fail rendering.
4. Show the operator the source beside each personalized statement.

### E. Review and approval
1. Operator selects recipients, sender, sequence, schedule, and caps.
2. System runs readiness checks and renders every message.
3. UI summarizes warnings, unsupported claims, duplicate domains, and contact verification.
4. Operator submits a frozen version.
5. Approver sees sender, audience, exact copy, timing, follow-up rules, limits, and sample/full recipient export together.
6. Approval records the exact hash. Any edit creates a new version and invalidates prior approval for launch.

### F. Campaign execution
1. Launch service verifies approval hash and current integration health.
2. Scheduler creates idempotent delivery jobs within timezone and cap rules.
3. Worker rechecks pause state and suppression immediately before send.
4. Adapter sends one exact rendered message.
5. Persist provider IDs and delivery events.
6. Retries use categorized errors and exponential backoff; hard bounces and policy failures never retry.
7. Replies, bounces, unsubscribes, and conversions stop future steps for that prospect.
8. Global and workspace kill switches stop new sends.

### G. Reply handling
1. Authenticate and deduplicate inbound webhook.
2. Link to thread, prospect, campaign, and prior delivery.
3. Apply immediate suppression for unsubscribe language/provider signal.
4. Classify with confidence and evidence.
5. Draft a response where useful.
6. Route to the correct review queue. Do not auto-send outside an approved narrow policy.

### H. Conversion and learning
1. Receive manual, CRM, calendar, signup, or revenue events.
2. Attribute using deterministic references first, then documented fallback windows.
3. Report delivered, bounced, replied, positive, meeting, signup, and revenue rates.
4. Suggestions generate a new draft/version; the system does not mutate an approved running campaign in place.

## 8. API and command boundaries

Use server-only commands for mutations. REST paths below can also be implemented as typed route handlers; domain services must not depend on HTTP.

### Query APIs
- `GET /api/workspaces`
- `GET /api/workspaces/:workspaceId/config`
- `GET /api/workspaces/:workspaceId/prospects?filters=`
- `GET /api/workspaces/:workspaceId/prospects/:personId`
- `GET /api/workspaces/:workspaceId/campaigns`
- `GET /api/workspaces/:workspaceId/campaigns/:campaignId`
- `GET /api/workspaces/:workspaceId/campaign-versions/:versionId/review`
- `GET /api/workspaces/:workspaceId/replies`
- `GET /api/workspaces/:workspaceId/analytics`
- `GET /api/workspaces/:workspaceId/audit`

### Command APIs
- `POST /api/workspaces`
- `POST /api/workspaces/:workspaceId/integrations/:provider/connect`
- `POST /api/workspaces/:workspaceId/prospects/imports`
- `POST /api/workspaces/:workspaceId/prospect-searches`
- `POST /api/workspaces/:workspaceId/qualification-runs`
- `POST /api/workspaces/:workspaceId/campaigns`
- `POST /api/workspaces/:workspaceId/campaigns/:campaignId/versions`
- `POST /api/workspaces/:workspaceId/campaign-versions/:versionId/validate`
- `POST /api/workspaces/:workspaceId/campaign-versions/:versionId/request-approval`
- `POST /api/workspaces/:workspaceId/approval-requests/:approvalId/approve`
- `POST /api/workspaces/:workspaceId/approval-requests/:approvalId/reject`
- `POST /api/workspaces/:workspaceId/campaign-versions/:versionId/launch`
- `POST /api/workspaces/:workspaceId/campaign-runs/:runId/pause`
- `POST /api/workspaces/:workspaceId/campaign-runs/:runId/resume`
- `POST /api/workspaces/:workspaceId/campaign-runs/:runId/stop`
- `POST /api/workspaces/:workspaceId/reply-drafts/:draftId/request-approval`
- `POST /api/workspaces/:workspaceId/reply-drafts/:draftId/send`
- `POST /api/workspaces/:workspaceId/suppressions`
- `POST /api/webhooks/:provider` (provider-authenticated, no user session)

### API rules
- Validate all inputs and AI outputs against versioned schemas.
- Require idempotency keys for imports, launch, send, reply-send, and webhook processing.
- Return typed error codes: authorization, tenancy mismatch, stale version, approval mismatch, suppression, cap reached, provider unavailable, validation, conflict.
- Use optimistic concurrency on editable resources (`revision` or `updated_at` precondition).
- Never accept a client-supplied `approved=true`, actor ID, organization ID, or workspace scope as authority.
- Long operations return job IDs and expose progress; requests stay short.

## 9. Queue jobs

Initial job types:
- `prospect.import`
- `prospect.discover`
- `prospect.dedupe`
- `prospect.qualify`
- `contact.verify`
- `personalization.generate`
- `campaign.validate`
- `campaign.schedule`
- `message.send`
- `message.followup.schedule`
- `webhook.process`
- `reply.classify`
- `reply.draft`
- `conversion.ingest`
- `analytics.rollup`
- `integration.healthcheck`

Each job defines an idempotency key, retry policy, timeout, tenant concurrency, input schema version, and dead-letter action. Sending jobs must be at-least-once safe at the application layer.

## 10. UI surface

### Global shell
- Workspace switcher with clear business name and environment.
- Role-aware navigation.
- Global send-state indicator and emergency stop control.
- Integration health and job-failure alerts.

### Screens
1. **Workspace setup:** business, offer, ICP, exclusions, claims, success events, timezone, policies.
2. **Integrations and senders:** provider status, verified identity, caps, health, reconnect.
3. **Prospects:** import/discover, filters, dedupe queue, qualification score, evidence, contact verification.
4. **Prospect detail:** company/person facts, source evidence, research notes, history, suppression state.
5. **Sequence builder:** step editor, allowed variables, delay and stop rules, rendering test.
6. **Campaign builder:** audience, sender, offer, sequence, schedule, caps, warnings.
7. **Approval review:** immutable version, hash/version, exact copy, recipient manifest, samples, warnings, approve/reject note.
8. **Campaign operations:** scheduled/sent/replied counts, pause/resume/stop, errors, provider status.
9. **Reply inbox:** categories, confidence, original thread, draft, approval/send controls.
10. **Analytics:** funnel and attribution by workspace, campaign, sender, variant, and source.
11. **Suppressions:** search/add/import/export, reason, scope, source.
12. **Audit log:** filter by actor/action/resource with trace IDs.

The review and approval screens must make a wrong sender, audience, or schedule easy to catch. Do not hide these in secondary panels.

## 11. Milestones

### M0: Repository and architecture decision (1-2 days)
- Confirm repo, stack, hosting, queue, auth, initial mailbox/provider, data source, and environment strategy.
- Add ADRs, project skeleton, CI, lint/type/test gates, migration system, secret handling, and deployment preview.

**Exit:** local and staging app deploy; authenticated user can open an empty workspace; CI is green.

### M1: Tenancy, workspace setup, and audit foundation (4-6 days)
- Organization/workspace/membership schema, RBAC, row-level security, workspace switcher.
- Offers, ICPs, claims, policies, sender/integration records.
- Audit event writer and cross-tenant security tests.

**Exit:** two seeded workspaces remain isolated across UI, API, DB policy, queue fixtures, and logs.

### M2: Prospect import, evidence, dedupe, qualification (6-8 days)
- CSV import first; one discovery adapter can follow.
- Normalization, dedupe, evidence records, qualification model run, research queue, contact verification interface.

**Exit:** operator imports a list, resolves duplicates, sees cited qualification, and cannot advance unverified/excluded contacts.

### M3: Sequence generation and campaign approval (6-8 days)
- Sequence builder, personalization, source citations, warnings, full rendering.
- Campaign versions, canonical payload/hash, readiness validation, approval UI and audit.

**Exit:** approved version is immutable; edits create a new version; launch refuses stale/unapproved hashes.

### M4: Controlled sending and follow-ups (7-10 days)
- First mailbox adapter, send/schedule jobs, caps, windows, idempotency, retries, webhooks, suppression, pause/stop.

**Exit:** a staging campaign sends to controlled test inboxes exactly once, respects caps/windows/suppressions, stops follow-ups on reply/bounce/unsubscribe, and pauses before further sends.

### M5: Reply triage and response drafts (5-7 days)
- Inbound thread linking, classification, confidence, draft generation, review/send, sensitive-category rules.

**Exit:** all tested replies are linked, unsubscribe suppresses immediately, sensitive replies cannot auto-send, approved draft sends once in the right thread.

### M6: Conversion tracking, analytics, and pilot hardening (5-7 days)
- Manual/webhook conversion ingestion, deterministic attribution, funnel, provider health, dead-letter UI, retention, backup/runbooks.
- Pilot with 2-3 internal campaigns and deliberately small caps.

**Exit:** each pilot has an auditable path from source evidence through approval, send, reply, and conversion; operational runbook covers pause, provider outage, webhook replay, and credential rotation.

Estimated MVP: roughly 6-9 weeks for one experienced full-stack engineer, depending on provider integrations and the quality of existing infrastructure. This is planning guidance, not a fixed commitment.

## 12. Acceptance criteria

### Tenancy and access
- A user without workspace access receives no existence leak, not only no content.
- Automated tests attempt cross-tenant access for every workspace-owned resource class.
- Background jobs and webhooks cannot act across workspace boundaries.
- Secrets never reach client bundles, normal logs, AI prompts, or audit metadata.

### Prospect quality
- Every qualification reason that relies on an external fact cites an evidence item.
- Low-confidence or contradictory records are visibly queued for review.
- Duplicate people cannot be active twice in one campaign version.
- Contact points show `unverified`, `verified`, `risky`, or `invalid`; inferred data is never labeled verified.

### Approval integrity
- Review displays sender, exact audience/manifest, complete sequence, timing, channel, caps, and follow-up rules together.
- Approval records approver, timestamp, payload hash, and version.
- Any material edit changes the hash and prevents launch under the old approval.
- API and database rules prevent mutation of an approved/published version.

### Delivery safety
- Each intended message is sent at most once from the application's point of view under retries and webhook replay.
- Suppression is checked immediately before send.
- Pause prevents every not-yet-sent job from sending within a defined operational target, proposed under 60 seconds.
- Hard bounce, unsubscribe, reply, or conversion applies the configured stop rules before another follow-up.
- Workspace, sender, daily, and per-domain caps are enforced transactionally.
- All delivery and provider events are traceable through request/job/provider IDs.

### Reply safety
- Inbound events are authenticated and idempotent.
- Unsubscribe creates suppression without waiting for AI.
- Interested, negotiation, complaint, legal, pricing-exception, and low-confidence replies require human approval.
- Reply send validates the current thread, recipient, sender, exact body, approval if required, and suppression state.

### Analytics and audit
- Funnel counts reconcile to underlying prospect/message records.
- Conversion attribution states the rule used and does not silently overwrite history.
- Every approval, launch, pause, resume, stop, send, suppression, integration change, and manual reply send creates an audit event.
- Audit export is workspace-scoped and excludes secrets.

### Reliability
- Provider webhooks can be replayed without duplicate sends or events.
- Failed jobs are visible, retryable where safe, and dead-lettered after policy limits.
- Integration health blocks new launches when sender validity is unknown.
- Database backup restore and credential rotation are tested before live pilot.

## 13. Testing strategy

- Unit tests for normalization, dedupe rules, state transitions, payload hashing, caps, stop conditions, and classification policy.
- Property tests for canonical payload serialization and hash stability.
- Integration tests against Postgres RLS and queue idempotency.
- Contract tests for each provider adapter and webhook signature verifier.
- End-to-end tests covering draft -> approval -> launch -> reply -> suppression/conversion.
- Security tests for IDOR, cross-tenant leakage, role escalation, webhook spoofing, prompt injection in prospect evidence, and secret redaction.
- Load tests for scheduler caps and webhook bursts.
- Manual pilot checklist using only controlled inboxes before real prospects.

## 14. First implementation slice after repo confirmation

Build one vertical path rather than all modules in parallel:
1. Authenticated workspace with tenancy and audit.
2. CSV import of prospects and evidence.
3. Manual verified contact status.
4. One ICP qualification run.
5. One two-step email sequence with personalization.
6. Immutable approval payload and review screen.
7. Test-mailbox send adapter with caps, suppression, and pause.
8. Reply webhook, unsubscribe handling, and draft-only triage.

This proves the hardest boundaries before adding automated discovery, more providers, CRM sync, or broader analytics.

## 15. Decisions to collect with the repo answer

Ask for one compact implementation handoff:
1. Existing repo URL + branch, or permission to create a new repo and preferred name.
2. Accept the default stack, or name required alternatives.
3. Hosting target.
4. First outbound/inbound mailbox provider and sending domain.
5. First prospect source: CSV only, CRM, or a named data provider.
6. Who should hold approver access in v1.
7. Initial live pilot workspace/business and maximum daily send cap.

Only items 1-2 are required to start the skeleton. Provider and pilot choices are required before the corresponding integration and live-send milestones.
