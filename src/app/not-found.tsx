import Link from "next/link";

export default function RootNotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-950 px-6">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-ink-900 shadow-panel">
          <span className="text-lg font-semibold text-flare">⌁</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-fg-mute">This page does not exist, or you do not have access to it.</p>
        <Link href="/" className="btn-primary mt-6 inline-block">Back to your workspace</Link>
      </div>
    </main>
  );
}
