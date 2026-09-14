import { recordUnsubscribe } from "@/server/unsubscribe";

export const dynamic = "force-dynamic";

const page = (title: string, body: string) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <title>${title}</title>
   <style>body{background:#0a0c10;color:#e6e9ef;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
   main{max-width:26rem;text-align:center;padding:0 1.5rem}h1{font-size:1.25rem;font-weight:600}p{color:#9aa3b2;font-size:.875rem;line-height:1.6}</style></head>
   <body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } },
);

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await recordUnsubscribe(token).catch((): { ok: boolean; email?: string } => ({ ok: false }));
  if (!result.ok) {
    return page("Link not recognized", "This unsubscribe link is invalid or has expired. If you keep receiving email you did not ask for, reply to any message and we will remove you.");
  }
  return page("You are unsubscribed", `${result.email} will not receive further outreach from this sender. No further action is needed.`);
}

// RFC 8058 one-click: mail clients POST here without rendering a page
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  return GET(_req, ctx);
}
