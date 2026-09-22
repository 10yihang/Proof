import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useId, type ReactNode } from "react";

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
  const group = useId();
  const reduced = useReducedMotion();
  return (
    <LayoutGroup id={group}>
      <ToggleGroup
        value={[value]}
        onValueChange={(values) => {
          if (values[0]) onChange(values[0]);
        }}
        aria-label={label}
        data-slot="segmented"
        className={className}
      >
        {items.map((item) => (
          <Toggle key={item.value} value={item.value}>
            {value === item.value && (
              <motion.span
                aria-hidden="true"
                className="proof-segment-indicator"
                layoutId="segment-selection"
                initial={false}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 460, damping: 38 }
                }
              />
            )}
            <span className="proof-segment-label">{item.label}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </LayoutGroup>
  );
}
