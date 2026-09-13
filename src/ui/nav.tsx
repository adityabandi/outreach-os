"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
  Dashboard: "◈", Prospects: "◉", Campaigns: "▲", Replies: "✉", Analytics: "▤",
  Suppressions: "⊘", "Audit log": "≡", Outbox: "➤", Settings: "⚙",
};

export function NavLink({ slug, name, path }: { slug: string; name: string; path: string }) {
  const pathname = usePathname();
  const href = `/w/${slug}${path}`;
  const active = path === "" ? pathname === href : pathname.startsWith(href);
  return (
    <Link href={href} className={`navlink ${active ? "navlink-active" : ""}`}>
      <span className={`w-4 text-center text-[13px] ${active ? "text-flare" : "text-fg-faint"}`}>{ICONS[name] ?? "·"}</span>
      {name}
    </Link>
  );
}
