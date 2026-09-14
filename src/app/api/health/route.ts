import { NextResponse } from "next/server";
import { withSystem } from "@/db/client";

/** Liveness + database reachability. No tenancy, no auth. */
export async function GET() {
  try {
    await withSystem((db) => db.query("select 1"));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
