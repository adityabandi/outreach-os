import { Panel, Empty, LinkButton } from "@/ui/primitives";

// Note: not-found pages do not receive route params, so link to the app root
// (which resolves the user's workspace) rather than a workspace-scoped path.
export default function WorkspaceNotFound() {
  return (
    <Panel>
      <Empty
        title="Not found in this workspace"
        hint="It may have been removed, or the link points at a different workspace."
        action={<LinkButton href="/" kind="primary">Back to your workspace</LinkButton>}
      />
    </Panel>
  );
}
