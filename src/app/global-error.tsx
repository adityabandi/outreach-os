"use client";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: "#0a0c10", color: "#e6e9ef", fontFamily: "system-ui, sans-serif" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center" }}>
            <h1 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h1>
            <p style={{ marginTop: 8, fontSize: 14, color: "#9aa3b2" }}>An unexpected error occurred.</p>
            <button onClick={reset} style={{ marginTop: 24, padding: "8px 16px", borderRadius: 8, background: "#f5b23c", color: "#0a0c10", fontWeight: 600 }}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
