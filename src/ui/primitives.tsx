import Link from "next/link";
import type { ReactNode } from "react";

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function PanelHeader({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-fg-mute">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

const PILL_TONES: Record<string, string> = {
  amber: "border-flare/40 bg-flare/10 text-flare",
  green: "border-mint/40 bg-mint/10 text-mint",
  red: "border-rose/40 bg-rose/10 text-rose",
  blue: "border-sky/40 bg-sky/10 text-sky",
  purple: "border-lilac/40 bg-lilac/10 text-lilac",
  gray: "border-line-strong bg-ink-750 text-fg-mute",
};

export function Pill({ tone = "gray", children, dot }: { tone?: keyof typeof PILL_TONES; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`pill ${PILL_TONES[tone]}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function StatePill({ state }: { state: string }) {
  const map: Record<string, [keyof typeof PILL_TONES, string]> = {
    draft: ["gray", "Draft"],
    ready_for_review: ["blue", "Ready for review"],
    approval_pending: ["amber", "Awaiting approval"],
    approved: ["green", "Approved"],
    scheduled: ["blue", "Scheduled"],
    running: ["green", "Running"],
    paused: ["amber", "Paused"],
    completed: ["gray", "Completed"],
    rejected: ["red", "Rejected"],
    cancelled: ["gray", "Cancelled"],
    stopped: ["red", "Stopped"],
    failed: ["red", "Failed"],
    sent: ["green", "Sent"],
    suppressed: ["red", "Suppressed"],
    skipped: ["gray", "Skipped"],
    pending: ["amber", "Pending"],
    qualified: ["green", "Qualified"],
    research_queue: ["amber", "Research queue"],
    disqualified: ["red", "Disqualified"],
    verified: ["green", "Verified"],
    unverified: ["gray", "Unverified"],
    risky: ["amber", "Risky"],
    invalid: ["red", "Invalid"],
    healthy: ["green", "Healthy"],
  };
  const [tone, label] = map[state] ?? ["gray", state.replace(/_/g, " ")];
  return <Pill tone={tone} dot>{label}</Pill>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="panel px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-faint">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-mute">{hint}</div>}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="text-sm font-medium text-fg-soft">{title}</div>
      {hint && <div className="max-w-sm text-xs text-fg-mute">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function HashChip({ hash }: { hash: string | null }) {
  if (!hash) return null;
  return (
    <code className="rounded-md border border-line bg-ink-850 px-2 py-1 font-mono text-[11px] text-fg-mute">
      sha256 {hash.slice(0, 12)}…
    </code>
  );
}

export function LinkButton({ href, children, kind = "ghost" }: { href: string; children: ReactNode; kind?: "ghost" | "primary" | "danger" }) {
  const cls = kind === "primary" ? "btn-primary" : kind === "danger" ? "btn-danger" : "btn-ghost";
  return <Link href={href} className={cls}>{children}</Link>;
}
