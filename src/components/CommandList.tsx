import { useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { t } from "../i18n";
interface Command {
  label: string;
  icon: ReactNode;
  detail?: string;
  run: () => void;
  disabled?: boolean;
}
export function CommandList({ actions }: { actions: Command[] }) {
  const [query, setQuery] = useState("");
  const filtered = actions.filter((action) =>
    `${action.label} ${action.detail ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Combobox.Root<Command>
      items={filtered}
      itemToStringLabel={(action) => action.label}
      value={null}
      onValueChange={(action) => {
        if (action && !action.disabled) action.run();
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      open
      inline
      autoHighlight
    >
      <div className="command-search mb-3 flex h-9 items-center gap-2 rounded-md border border-border px-3">
        <MagnifyingGlass size={16} className="text-muted-foreground" />
        <Combobox.Input
          autoFocus
          data-autofocus
          aria-label={t("搜索命令")}
          placeholder={t("搜索命令…")}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </div>
      <Combobox.List
        className="proof-command-list max-h-80 overflow-auto"
        aria-label={t("可用命令")}
      >
        {(action: Command) => (
          <Combobox.Item
            key={action.label}
            value={action}
            disabled={action.disabled}
            className="flex min-h-10 cursor-default items-center gap-3 rounded-md px-3 py-2 text-[12px] outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-40"
          >
            {action.icon}
            <span>{action.label}</span>
            {action.detail && (
              <small className="ml-auto max-w-48 truncate text-muted-foreground">
                {action.detail}
              </small>
            )}
            {action.disabled && (
              <small className="ml-auto">{t("当前不可用")}</small>
            )}
          </Combobox.Item>
        )}
      </Combobox.List>
      <Combobox.Empty className="py-6 text-center text-[12px] text-muted-foreground">
        {t("没有匹配的命令")}
      </Combobox.Empty>
    </Combobox.Root>
  );
}
