import { loginAction } from "@/server/actions";
import { withSystem } from "@/db/client";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const { error } = await searchParams;
  const users = await withSystem(async (db) => {
    const r = await db.query(`select email, display_name from users where status = 'active' order by display_name`);
    return r.rows as { email: string; display_name: string }[];
  });
  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-ink-900 shadow-panel">
            <span className="text-lg font-semibold text-flare">⌁</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Outreach OS</h1>
          <p className="mt-1 text-sm text-fg-mute">Sign in to your workspace</p>
        </div>
        <div className="panel p-5">
          <form action={loginAction} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">Account</label>
              <select id="email" name="email" className="input" defaultValue={users[0]?.email}>
                {users.map((u) => (
                  <option key={u.email} value={u.email}>{u.display_name} - {u.email}</option>
                ))}
              </select>
            </div>
            {error && <p className="text-xs text-rose">Unknown account. Pick one from the list.</p>}
            <button type="submit" className="btn-primary w-full">Continue</button>
          </form>
          <p className="mt-4 text-center text-[11px] leading-relaxed text-fg-faint">
            Development sign-in. Production builds authenticate through your managed OIDC provider.
          </p>
        </div>
      </div>
    </main>
  );
}
