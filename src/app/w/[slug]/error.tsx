"use client";

import { Panel, Empty } from "@/ui/primitives";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Panel>
      <Empty
        title="Something went wrong"
        hint="The action was not completed. Nothing was sent or changed outside this workspace."
        action={
          <button onClick={reset} className="btn-primary">Try again</button>
        }
      />
    </Panel>
  );
}
