import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import type { ReactNode } from "react";
export function Segmented<T extends string>({
  value,
  onChange,
  label,
  className = "segmented",
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  items: { value: T; label: ReactNode }[];
}) {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(values) => {
        if (values[0]) onChange(values[0]);
      }}
      aria-label={label}
      className={className}
    >
      {items.map((item) => (
        <Toggle key={item.value} value={item.value}>
          {item.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
