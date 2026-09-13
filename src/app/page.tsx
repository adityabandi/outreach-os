import { redirect } from "next/navigation";
import { currentActor, listAccessibleWorkspaces } from "@/server/auth";

export default async function Home() {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  const workspaces = await listAccessibleWorkspaces(actor);
  if (workspaces.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-fg-mute">No workspaces are available to this account.</p>
      </main>
    );
  }
  redirect(`/w/${workspaces[0].slug}`);
}
