// Suppression + caps. Pure decision functions; DB queries live in the service layer.
export interface SuppressionHit {
  suppressed: boolean;
  reason?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function domainOf(emailOrDomain: string): string {
  const v = emailOrDomain.trim().toLowerCase();
  return v.includes("@") ? v.split("@")[1] : v;
}

/** An entry suppresses a recipient when it matches exactly, by domain, or globally. */
export function matchesSuppression(
  entries: { scope: string; normalized_value: string; expires_at: string | null }[],
  email: string,
  now = new Date(),
): SuppressionHit {
  const addr = normalizeEmail(email);
  const dom = domainOf(addr);
  for (const e of entries) {
    if (e.expires_at && new Date(e.expires_at) <= now) continue;
    if (e.scope === "global") return { suppressed: true, reason: e.normalized_value };
    if (e.scope === "domain" && e.normalized_value === dom)
      return { suppressed: true, reason: `domain ${dom} suppressed` };
    if (e.normalized_value === addr) return { suppressed: true, reason: `${addr} suppressed` };
  }
  return { suppressed: false };
}

export interface CapUsage {
  workspaceToday: number;
  senderToday: number;
  domainToday: number;
}

export interface CapLimits {
  workspaceDaily: number;
  senderDaily: number;
  perDomain: number;
}

export function capAllowance(usage: CapUsage, limits: CapLimits) {
  return {
    workspace: Math.max(0, limits.workspaceDaily - usage.workspaceToday),
    sender: Math.max(0, limits.senderDaily - usage.senderToday),
    domain: Math.max(0, limits.perDomain - usage.domainToday),
  };
}

export function withinSendWindow(
  at: Date,
  timezone: string,
  window: { start_hour: number; end_hour: number },
): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(at),
  );
  if (window.start_hour <= window.end_hour) {
    return hour >= window.start_hour && hour < window.end_hour;
  }
  return hour >= window.start_hour || hour < window.end_hour; // overnight window
}
