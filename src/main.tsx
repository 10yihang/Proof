import { useLanguage } from "./i18n";
import { useApplicationLanguage } from "./i18n-controller";
import React from "react";
import { useDiffEvents } from "./diff-events";
import { clearSyntaxCache } from "./syntax";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UIProvider } from "./components/ui/provider";
import { DiffWindow } from "./components/DiffWindow";
import "./styles/theme.css";
import "./styles/application.css";
import type { DataSessionChange } from "./api";

function AppShell() {
  useDiffEvents();
  useLanguage();
  const active = React.useRef<string | undefined>(undefined);
  const [session, setSession] = React.useState<{
    key: number;
    restore?: string;
    notice?: string;
  }>({ key: 0 });
  useApplicationLanguage(session.key);
  React.useEffect(() => {
    const changed = (event: Event) => {
      clearSyntaxCache();
      const {
        session: next,
        previousEpoch,
        notice,
      } = (event as CustomEvent<DataSessionChange>).detail;
      const restore =
        active.current &&
        !next.deletedWorkspaceIds.includes(active.current) &&
        next.wipeEpoch <= previousEpoch
          ? active.current
          : undefined;
      // Remount the whole renderer, including hidden History/Context panels and
      // async settings drafts. The API has already invalidated old responses.
      active.current = restore;
      setSession({ key: next.epoch, restore, notice });
    };
    window.addEventListener("proof:data-session-changed", changed);
    return () =>
      window.removeEventListener("proof:data-session-changed", changed);
  }, [session.key]);
  const onWorkspaceChange = React.useCallback((id?: string) => {
    active.current = id;
  }, []);
  if (new URLSearchParams(location.search).has("diffWindow"))
    return <DiffWindow key={session.key} />;
  return (
    <App
      key={session.key}
      initialWorkspaceId={session.restore}
      initialDataNotice={session.notice}
      onWorkspaceChange={onWorkspaceChange}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UIProvider>
      <AppShell />
    </UIProvider>
  </React.StrictMode>,
);
