import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { RepositoryView } from "../../../src/components/RepositoryView";
import { useHistoryActions } from "../../../src/components/HistoryActions";
import { UIProvider } from "../../../src/components/ui/provider";
import { demoChanges } from "../../../src/demo";
import { setLanguage } from "../../../src/i18n";
import "../../../src/styles/theme.css";
import "../../../src/styles/application.css";

setLanguage("en");
function Harness() {
  const fixture = (window as any).historyPerformance;
  const [active, setActive] = useState(true);
  const [changes, setChanges] = useState({
    ...demoChanges,
    head: fixture.commits[0].oid,
    workspace: {
      ...demoChanges.workspace,
      id: "history-performance",
      trusted: true,
    },
  });
  const actions = useHistoryActions(
    changes,
    false,
    async () => {},
    () => {},
    active,
  );
  return (
    <>
      <header style={{ height: 40, display: "flex", gap: 20 }}>
        <button onClick={() => setActive(false)}>Local changes</button>
        <button onClick={() => setActive(true)}>History</button>
        <button
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("proof:git-updated", {
                detail: { workspaceId: changes.workspace.id },
              }),
            )
          }
        >
          Invalidate history
        </button>
        <button
          onClick={() => {
            fixture.head = fixture.commits[1].oid;
            setChanges((previous) => ({ ...previous, head: fixture.head }));
          }}
        >
          Change HEAD
        </button>
        <output data-testid="revision">{actions.graphRevision}</output>
      </header>
      <div
        className="harness-history"
        hidden={!active}
        style={{ height: 800, display: active ? "flex" : "none" }}
      >
        <RepositoryView
          active={active}
          actions={actions}
          section="history"
          onSection={() => {}}
          changes={changes}
          demo={false}
          onOpen={async () => {}}
          onError={(error) => {
            throw error;
          }}
          onOpenDiff={() => {}}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <UIProvider>
    <Harness />
  </UIProvider>,
);
