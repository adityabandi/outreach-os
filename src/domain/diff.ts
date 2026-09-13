// Pure version-to-version diffing for the approval screen. An approver must see
// exactly what changed since the version they (or a predecessor) last reviewed -
// audience deltas, setting changes, and line-level copy edits.

export interface DiffRecipient { email: string; name?: string }
export interface SettingChange { label: string; from: string; to: string }
export interface DiffLine { type: "same" | "add" | "del"; text: string }
export interface StepChange {
  step: number;
  kind: "added" | "removed" | "changed";
  subjectFrom?: string;
  subjectTo?: string;
  bodyDiff?: DiffLine[];
}
export interface VersionDiff {
  audienceAdded: DiffRecipient[];
  audienceRemoved: DiffRecipient[];
  settingChanges: SettingChange[];
  stepChanges: StepChange[];
  unchanged: boolean;
}

interface SeqStep { step_number: number; delay_minutes: number; subject_template: string; body_template: string }
interface DiffPayload {
  sender_identity_id: string;
  channel: string;
  sequence: SeqStep[];
  delivery: { timezone: string; send_window: { start_hour: number; end_hour: number }; daily_workspace_cap: number; sender_daily_cap: number; per_domain_cap: number };
  follow_up: { enabled: boolean };
  reply_policy: { auto_send: boolean };
  suppression_policy: { check_before_send: boolean };
}

/** LCS line diff. Bodies are short (<200 lines), DP is fine and exact. */
export function diffLines(a: string, b: string): DiffLine[] {
  const al = a.split("\n"), bl = b.split("\n");
  const n = al.length, m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { out.push({ type: "same", text: al[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: al[i] }); i++; }
    else { out.push({ type: "add", text: bl[j] }); j++; }
  }
  while (i < n) out.push({ type: "del", text: al[i++] });
  while (j < m) out.push({ type: "add", text: bl[j++] });
  return out;
}

const yn = (v: boolean) => (v ? "on" : "off");

export function diffVersions(
  prev: { payload: DiffPayload; recipients: DiffRecipient[] },
  next: { payload: DiffPayload; recipients: DiffRecipient[] },
  formatSender: (id: string) => string = (id) => id,
): VersionDiff {
  const prevEmails = new Map(prev.recipients.map((r) => [r.email.toLowerCase(), r]));
  const nextEmails = new Map(next.recipients.map((r) => [r.email.toLowerCase(), r]));
  const audienceAdded = [...nextEmails.entries()].filter(([e]) => !prevEmails.has(e)).map(([, r]) => r);
  const audienceRemoved = [...prevEmails.entries()].filter(([e]) => !nextEmails.has(e)).map(([, r]) => r);

  const p = prev.payload, q = next.payload;
  const settingChanges: SettingChange[] = [];
  const cmp = (label: string, from: string, to: string) => { if (from !== to) settingChanges.push({ label, from, to }); };
  cmp("Sender", formatSender(p.sender_identity_id), formatSender(q.sender_identity_id));
  cmp("Channel", p.channel, q.channel);
  cmp("Workspace daily cap", String(p.delivery.daily_workspace_cap), String(q.delivery.daily_workspace_cap));
  cmp("Sender daily cap", String(p.delivery.sender_daily_cap), String(q.delivery.sender_daily_cap));
  cmp("Per-domain cap", String(p.delivery.per_domain_cap), String(q.delivery.per_domain_cap));
  const win = (d: DiffPayload["delivery"]) => `${d.send_window.start_hour}:00-${d.send_window.end_hour}:00 ${d.timezone}`;
  cmp("Send window", win(p.delivery), win(q.delivery));
  cmp("Follow-ups", yn(p.follow_up.enabled), yn(q.follow_up.enabled));
  cmp("Reply auto-send", yn(p.reply_policy.auto_send), yn(q.reply_policy.auto_send));
  cmp("Suppression pre-send check", yn(p.suppression_policy.check_before_send), yn(q.suppression_policy.check_before_send));

  const prevSteps = new Map(p.sequence.map((s) => [s.step_number, s]));
  const nextSteps = new Map(q.sequence.map((s) => [s.step_number, s]));
  const stepChanges: StepChange[] = [];
  for (const n of [...new Set([...prevSteps.keys(), ...nextSteps.keys()])].sort((a, b) => a - b)) {
    const a = prevSteps.get(n), b = nextSteps.get(n);
    if (a && !b) stepChanges.push({ step: n, kind: "removed" });
    else if (!a && b) stepChanges.push({ step: n, kind: "added", subjectTo: b.subject_template, bodyDiff: b.body_template.split("\n").map((text) => ({ type: "add" as const, text })) });
    else if (a && b && (a.subject_template !== b.subject_template || a.body_template !== b.body_template || a.delay_minutes !== b.delay_minutes)) {
      stepChanges.push({
        step: n, kind: "changed",
        subjectFrom: a.subject_template !== b.subject_template ? a.subject_template : undefined,
        subjectTo: a.subject_template !== b.subject_template ? b.subject_template : undefined,
        bodyDiff: a.body_template !== b.body_template ? diffLines(a.body_template, b.body_template) : undefined,
      });
      if (a.delay_minutes !== b.delay_minutes)
        settingChanges.push({ label: `Step ${n} delay`, from: `${a.delay_minutes} min`, to: `${b.delay_minutes} min` });
    }
  }
  const unchanged = audienceAdded.length === 0 && audienceRemoved.length === 0 && settingChanges.length === 0 && stepChanges.length === 0;
  return { audienceAdded, audienceRemoved, settingChanges, stepChanges, unchanged };
}
