import { Field } from "@base-ui/react/field";
import {
  Children,
  Fragment,
  isValidElement,
  type ComponentProps,
  type ReactNode,
  type ChangeEvent,
} from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Slider } from "@base-ui/react/slider";
import { Button as StyledButton } from "./button";
import { Input as StyledInput } from "./input";
import { Checkbox as StyledCheckbox } from "./checkbox";
import { Switch as StyledSwitch } from "./switch";
import { Textarea } from "./textarea";
import {
  Select as SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
} from "./select";
import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip";
import { cn } from "@/lib/utils";

export function Button({
  className = "",
  title,
  type = "button",
  ...props
}: ComponentProps<"button">) {
  const standard = /(^|\s)(button|icon-button|text-button)(\s|$)/.test(
    className,
  );
  const icon = className.includes("icon-button");
  const element = standard ? (
    <StyledButton
      {...props}
      type={type}
      title={title}
      aria-label={props["aria-label"] ?? (icon ? title : undefined)}
      variant={
        className.includes("primary")
          ? "default"
          : /danger|destructive/.test(className)
            ? "destructive"
            : icon || /subtle|text-button/.test(className)
              ? "ghost"
              : "outline"
      }
      size={icon ? "icon-sm" : className.includes("compact") ? "sm" : "default"}
      className={cn(
        "proof-action rounded-md text-[12px] active:translate-y-0",
        className,
      )}
    />
  ) : (
    <ButtonPrimitive
      {...props}
      type={type}
      title={title}
      className={className}
    />
  );
  if (!title || props.disabled || props["aria-haspopup"]) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

export function Checkbox({
  onChange,
  className,
  ref,
  ...props
}: ComponentProps<"input">) {
  const { type: _type, value, ...rest } = props;
  return (
    <Field.Root render={<span className="contents" />}>
      <StyledCheckbox
        {...(rest as ComponentProps<typeof StyledCheckbox>)}
        inputRef={ref}
        value={typeof value === "string" ? value : undefined}
        className={cn("proof-checkbox rounded-[4px]", className)}
        onCheckedChange={(checked, details) =>
          onChange?.({
            ...details.event,
            target: { checked },
            currentTarget: { checked },
          } as unknown as ChangeEvent<HTMLInputElement>)
        }
      />
    </Field.Root>
  );
}

export function Input(props: ComponentProps<"input">) {
  if (props.type === "checkbox") return <Checkbox {...props} />;
  if (props.type === "range") return <RangeSlider {...props} />;
  return (
    <StyledInput
      {...props}
      data-autofocus={props.autoFocus || undefined}
      className={cn(
        "proof-input rounded-md border-border bg-background text-[12px] md:text-[12px]",
        props.className,
      )}
    />
  );
}
export function Switch({
  onChange,
  ref,
  className,
  ...props
}: ComponentProps<"input">) {
  const { type: _type, value, ...rest } = props;
  return (
    <Field.Root render={<span className="contents" />}>
      <StyledSwitch
        {...(rest as ComponentProps<typeof StyledSwitch>)}
        inputRef={ref}
        value={typeof value === "string" ? value : undefined}
        className={cn("proof-switch", className)}
        onCheckedChange={(checked, details) =>
          onChange?.({
            ...details.event,
            target: { checked },
            currentTarget: { checked },
          } as unknown as ChangeEvent<HTMLInputElement>)
        }
      />
    </Field.Root>
  );
}
export { Textarea };

function RangeSlider({
  value,
  defaultValue,
  min,
  max,
  step,
  onChange,
  disabled,
  name,
  id,
  className,
  ...props
}: ComponentProps<"input">) {
  return (
    <Slider.Root
      className={cn("proof-slider flex w-full items-center py-3", className)}
      value={value === undefined ? undefined : Number(value)}
      defaultValue={Number(defaultValue ?? min ?? 0)}
      min={Number(min ?? 0)}
      max={Number(max ?? 100)}
      step={Number(step ?? 1)}
      disabled={disabled}
      name={name}
      onValueChange={(value, details) =>
        onChange?.({
          ...details.event,
          target: { value: String(value) },
          currentTarget: { value: String(value) },
        } as unknown as ChangeEvent<HTMLInputElement>)
      }
    >
      <Slider.Control className="relative flex h-5 w-full items-center touch-none select-none">
        <Slider.Track className="h-1.5 w-full rounded-full bg-muted">
          <Slider.Indicator className="rounded-full bg-primary" />
          <Slider.Thumb
            id={id}
            aria-label={props["aria-label"]}
            aria-labelledby={props["aria-labelledby"]}
            className="size-3.5 rounded-full border border-primary bg-background shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
          />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

type Option = {
  value: string;
  label: ReactNode;
  disabled: boolean;
  group?: string;
};
function optionText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? optionText(child.props.children)
        : String(child),
    )
    .join("");
}
function optionsFrom(children: ReactNode, group?: string): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string | number;
        disabled?: boolean;
        label?: string;
      }>(child)
    )
      return [];
    if (child.type === Fragment)
      return optionsFrom(child.props.children, group);
    if (child.type === "optgroup")
      return optionsFrom(child.props.children, child.props.label);
    return [
      {
        value: String(child.props.value ?? optionText(child.props.children)),
        label: child.props.children,
        disabled: !!child.props.disabled,
        group,
      },
    ];
  });
}

/** Preserve existing controlled field contracts while all selects share one popup. */
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  className,
  popupClassName,
  disabled,
  name,
  required,
  id,
  title,
  autoFocus,
  ...props
}: ComponentProps<"select"> & { popupClassName?: string }) {
  const options = optionsFrom(children);
  const items = Object.fromEntries(
    options.map((option) => [option.value, option.label]),
  );
  return (
    <Field.Root render={<span className="contents" />}>
      <SelectRoot
        value={value === undefined ? undefined : String(value)}
        defaultValue={
          defaultValue === undefined ? options[0]?.value : String(defaultValue)
        }
        items={items}
        disabled={disabled}
        name={name}
        required={required}
        onValueChange={(value, details) => {
          if (value !== null)
            onChange?.({
              ...details.event,
              target: { value },
              currentTarget: { value },
            } as unknown as ChangeEvent<HTMLSelectElement>);
        }}
      >
        <SelectTrigger
          id={id}
          title={title}
          autoFocus={autoFocus}
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          data-value={value}
          className={cn(
            "proof-select h-8 rounded-md border-border bg-background text-[12px]",
            className,
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          align="start"
          alignItemWithTrigger={false}
          className={cn(
            "proof-select-popup rounded-lg border border-border text-[12px]",
            popupClassName,
          )}
        >
          {options.map((option, index) => (
            <Fragment key={option.value}>
              {option.group && option.group !== options[index - 1]?.group && (
                <SelectGroup>
                  <SelectLabel>{option.group}</SelectLabel>
                </SelectGroup>
              )}
              <SelectItem
                value={option.value}
                disabled={option.disabled}
                data-value={option.value}
                className="rounded-md text-[12px]"
              >
                {option.label}
              </SelectItem>
            </Fragment>
          ))}
        </SelectContent>
      </SelectRoot>
    </Field.Root>
  );
}
