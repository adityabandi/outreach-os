import { NextRequest, NextResponse } from "next/server";
import { withSystem } from "@/db/client";
import { handleWebhookPost, webhookSecretFor } from "@/server/webhooks";

/** Thin HTTP adapter; logic lives in src/server/webhooks.ts (unit-tested). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const raw = await req.text();
  const signature = req.headers.get("x-signature") ?? "";
  const outcome = await handleWebhookPost(provider, raw, signature, webhookSecretFor(provider), withSystem);
  return NextResponse.json(outcome.body, { status: outcome.status });
}
