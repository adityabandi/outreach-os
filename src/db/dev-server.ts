// Starts the local embedded Postgres 18 server used for development.
// Binaries come from the embedded-postgres npm package (userspace, no sudo).
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The native package's exports map only exposes its main entry, so resolve that
// and walk up to the package root (works regardless of the exports map).
const entry = require.resolve("@embedded-postgres/linux-x64");
const pkgRoot = entry.replace(/\/dist\/index\.js$/, "");
const bin = `${pkgRoot}/native/bin`;
const dir = process.env.PGDATA ?? `${process.env.HOME}/pgdata`;
const port = process.env.PGPORT ?? "5433";

if (!existsSync(`${dir}/PG_VERSION`)) {
  mkdirSync(dir, { recursive: true });
  const { writeFileSync } = require("node:fs");
  // Keep the pwfile outside the data dir: initdb refuses a non-empty directory.
  const pwfile = `${dir}.init-pw`;
  writeFileSync(pwfile, "outreach\n", { mode: 0o600 });
  execFileSync(`${bin}/initdb`, ["-D", dir, "-U", "outreach", "-E", "UTF8", `--pwfile=${pwfile}`], {
    stdio: "inherit",
  });
}
const child = spawn(`${bin}/postgres`, ["-D", dir, "-p", port, "-c", "listen_addresses=localhost"], {
  stdio: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
