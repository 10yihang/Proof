import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalDrawer } from "../../src/components/TerminalDrawer";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import "../../src/styles.css";

// Real TerminalDrawer + xterm; only native IPC is controlled by Playwright.
function Harness() {
  const [workspace, setWorkspace] = useState("/tmp/proof-terminal-A");
  const [mounted, setMounted] = useState(true);
  const [open, setOpen] = useState(true);
  return (
    <TooltipProvider>
      <div className="app" style={{ height: "100vh" }}>
        <div>
          <button onClick={() => setWorkspace("/tmp/proof-terminal-B")}>
            Switch workspace
          </button>
          <button onClick={() => setMounted(false)}>Unmount terminal</button>
          <button onClick={() => setOpen(!open)}>Toggle visibility</button>
        </div>
        {mounted && (
          <TerminalDrawer
            open={open}
            workspacePath={workspace}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
