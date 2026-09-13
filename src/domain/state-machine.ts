// Campaign/version lifecycle. Pure functions; the DB layer enforces immutability separately.
export type CampaignState =
  | "draft"
  | "ready_for_review"
  | "approval_pending"
  | "approved"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "rejected"
  | "cancelled"
  | "stopped"
  | "failed";

const TRANSITIONS: Record<CampaignState, CampaignState[]> = {
  draft: ["ready_for_review", "cancelled"],
  ready_for_review: ["approval_pending", "rejected", "cancelled", "draft"],
  approval_pending: ["approved", "rejected", "cancelled"],
  approved: ["scheduled", "cancelled"],
  scheduled: ["running", "cancelled", "failed"],
  running: ["paused", "completed", "stopped", "failed"],
  paused: ["running", "stopped", "failed"],
  completed: [],
  rejected: ["draft"],
  cancelled: [],
  stopped: [],
  failed: ["scheduled"],
};

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: CampaignState, to: CampaignState): void {
  if (!canTransition(from, to)) {
    throw new StateError(`illegal campaign transition ${from} -> ${to}`);
  }
}

/** States where the payload may still be edited. */
export const EDITABLE_STATES: CampaignState[] = ["draft", "rejected"];
/** States from which no unsent job may fire. */
export const SEND_BLOCKED_STATES: CampaignState[] = ["paused", "stopped", "cancelled", "failed", "completed"];

export type RunState = "scheduled" | "running" | "paused" | "stopped" | "completed" | "failed";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}
