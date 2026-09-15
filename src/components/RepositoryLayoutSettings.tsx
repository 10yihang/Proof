import { Button, Input, Select } from "./ui/controls";
import { t, uiMessage } from "../i18n";
import { useEffect, useState } from "react";
import { ArrowCounterClockwise, Minus, Plus } from "@phosphor-icons/react";
import {
  defaultRepositoryLayout,
  panelBounds,
  type LayoutSnapshot,
  type PanelWidth,
} from "../repository-layout";
import type { RepositoryLayout } from "../types";

export function RepositoryLayoutSettings({
  snapshot,
  name,
  demo,
  onChange,
  onReset,
  onRetry,
}: {
  snapshot: LayoutSnapshot;
  name: string;
  demo: boolean;
  onChange: (value: Partial<RepositoryLayout>) => void;
  onReset: () => void;
  onRetry: () => void;
}) {
  const { value, ready, saving, error } = snapshot;
  const custom = (
    Object.keys(defaultRepositoryLayout) as (keyof RepositoryLayout)[]
  ).some((key) => value[key] !== defaultRepositoryLayout[key]);
  return (
    <section className="repository-layout-settings" aria-label={t("仓库布局")}>
      <div className="layout-settings-heading">
        <h3>{t("仓库布局")}</h3>
        <span>{name}</span>
      </div>
      <p className="muted">
        {t("应用于此仓库及关联 Worktree。")}
        {demo && t("演示布局仅在本次体验中保留。")}
      </p>
      <div className="layout-save-status" role="status">
        {!ready
          ? t("尚未读取布局")
          : saving
            ? t("正在保存此仓库布局…")
            : custom
              ? t("此仓库已覆盖默认布局")
              : t("此仓库使用默认布局")}
      </div>
      {error && (
        <div className="layout-setting-error" role="alert">
          {ready
            ? saving
              ? t("有布局调整未保存，其余调整仍在保存。")
              : t("有布局调整未保存，当前显示已保存的值。")
            : t("无法读取此仓库布局。")}{" "}
          {uiMessage(error.message)}
          {!ready && <Button onClick={onRetry}>{t("重试读取")}</Button>}
        </div>
      )}
      <WidthSetting
        side="sidebarWidth"
        label={t("文件栏宽度")}
        value={value.sidebarWidth}
        disabled={!ready}
        onChange={onChange}
      />
      <WidthSetting
        side="contextWidth"
        label={t("上下文宽度")}
        value={value.contextWidth}
        disabled={!ready}
        onChange={onChange}
      />
      <label className="settings-toggle">
        <span>
          <strong>{t("显示文件栏")}</strong>
          <small>{t("窄窗通过按钮展开")}</small>
        </span>
        <Input
          type="checkbox"
          checked={value.sidebarOpen}
          disabled={!ready}
          onChange={(event) => onChange({ sidebarOpen: event.target.checked })}
        />
      </label>
      <label className="field-label" htmlFor="repository-context">
        {t("此仓库的 Context 面板")}
      </label>
      <Select
        id="repository-context"
        value={
          value.contextOpen === null ? "inherit" : String(value.contextOpen)
        }
        disabled={!ready}
        onChange={(event) =>
          onChange({
            contextOpen:
              event.target.value === "inherit"
                ? null
                : event.target.value === "true",
          })
        }
      >
        <option value="inherit">{t("跟随应用默认")}</option>
        <option value="true">{t("此仓库始终显示（窄窗收起）")}</option>
        <option value="false">{t("此仓库默认收起")}</option>
      </Select>
      <Button
        className="button compact layout-reset"
        disabled={!ready || saving || !custom}
        onClick={onReset}
      >
        <ArrowCounterClockwise size={15} />
        {t("恢复此仓库默认布局")}
      </Button>
    </section>
  );
}

function WidthSetting({
  side,
  label,
  value,
  disabled,
  onChange,
}: {
  side: PanelWidth;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: Partial<RepositoryLayout>) => void;
}) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(String(value));
    setInvalid(false);
  }, [value]);
  const bounds = panelBounds[side];
  function save() {
    const next = Number(text);
    const valid =
      text.trim() !== "" &&
      Number.isInteger(next) &&
      next >= bounds.min &&
      next <= bounds.max;
    setInvalid(!valid);
    if (valid && next !== value) onChange({ [side]: next });
  }
  return (
    <div className="layout-width-setting">
      <label htmlFor={`layout-${side}`}>
        {label}
        <small>
          {bounds.min}–{bounds.max}
          {t("px")}
        </small>
      </label>
      <div className="layout-width-controls">
        <Button
          className="icon-button"
          aria-label={t("减小{v0}", { v0: label })}
          disabled={disabled || value <= bounds.min}
          onClick={() => onChange({ [side]: Math.max(bounds.min, value - 20) })}
        >
          <Minus size={15} />
        </Button>
        <Input
          id={`layout-${side}`}
          type="number"
          min={bounds.min}
          max={bounds.max}
          step="1"
          value={text}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? `layout-error-${side}` : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setText(String(value));
              setInvalid(false);
            }
          }}
        />
        <Button
          className="icon-button"
          aria-label={t("增大{v0}", { v0: label })}
          disabled={disabled || value >= bounds.max}
          onClick={() => onChange({ [side]: Math.min(bounds.max, value + 20) })}
        >
          <Plus size={15} />
        </Button>
      </div>
      {invalid && (
        <span
          className="layout-setting-error"
          id={`layout-error-${side}`}
          role="alert"
        >
          {t("请输入 ")}
          {bounds.min}–{bounds.max} {t(" 之间的整数。")}
        </span>
      )}
    </div>
  );
}
