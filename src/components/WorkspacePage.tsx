import { Component, type ComponentProps, type ReactNode } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { t } from "../i18n";

class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex flex-1 items-center justify-center p-5 text-xs text-muted-foreground"
      >
        {t("无法显示此页面。")}
      </div>
    );
  }
}

// Hidden pages stay mounted, so their errors must stay inside their own panel.
export function WorkspacePage({
  children,
  ...props
}: ComponentProps<typeof Tabs.Panel>) {
  return (
    <Tabs.Panel {...props}>
      <PageErrorBoundary>{children}</PageErrorBoundary>
    </Tabs.Panel>
  );
}
