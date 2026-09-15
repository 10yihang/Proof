import { useEffect, useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { HotkeysProvider } from "react-hotkeys-hook";
import { TooltipProvider } from "./tooltip";
import { Toaster } from "./toast";

export function UIProvider({ children }: { children: ReactNode }) {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const clear = () => setEpoch((value) => value + 1);
    window.addEventListener("proof:data-session-changed", clear);
    return () =>
      window.removeEventListener("proof:data-session-changed", clear);
  }, []);
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <HotkeysProvider>
        <TooltipProvider delay={500}>
          {children}
          <Toaster key={epoch} timeout={4000} limit={3} />
        </TooltipProvider>
      </HotkeysProvider>
    </MotionConfig>
  );
}
