import { useSyncExternalStore } from "react";
import zh from "./i18n/zh-CN.json";
import en from "./i18n/en.json";

export type Language = "zh-CN" | "en";
export type MessageKey = keyof typeof zh;
type Parameters = Record<string, string | number>;
const english: Record<MessageKey, string> = en;
let language: Language = "zh-CN";
const subscribers = new Set<() => void>();
export function getLanguage() {
  return language;
}
export function isLanguage(value: unknown): value is Language {
  return value === "zh-CN" || value === "en";
}
export function setLanguage(value: Language) {
  if (typeof document !== "undefined") document.documentElement.lang = value;
  if (language === value) return;
  language = value;
  subscribers.forEach((notify) => notify());
}
export function useLanguage() {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    getLanguage,
    () => "zh-CN" as const,
  );
}
export function translate(
  key: MessageKey,
  locale: Language,
  values: Parameters = {},
) {
  let message = (locale === "en" ? english[key] : zh[key]) ?? zh[key] ?? key;
  // Pluralize only numeric placeholders in the authored English template,
  // before interpolation; never search or rewrite user-supplied values.
  if (locale === "en")
    message = message.replace(
      /\{(\w+)\} (files|hunks|Commits|events|entries|matches|days|Sessions)\b/g,
      (part, name: string, noun: string) => {
        if (values[name] !== 1) return part;
        const singular: Record<string, string> = {
          entries: "entry",
          matches: "match",
        };
        return `{${name}} ${singular[noun] ?? noun.slice(0, -1)}`;
      },
    );
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}
export function t(key: MessageKey, values?: Parameters) {
  return translate(key, language, values);
}

/** Only use for Proof-owned status/error text, never source, names or Agent output. */
export function uiMessage(value: string | null | undefined): string {
  if (!value) return value ?? "";
  if (Object.hasOwn(zh, value)) return t(value as MessageKey);
  const key = reverse.get(value);
  if (key) return t(key);
  for (const [source, pattern, names] of patterns) {
    const match = pattern.exec(value);
    if (match)
      return t(
        source,
        Object.fromEntries(
          names.map((name, index) => [name, match[index + 1]]),
        ),
      );
  }
  return value;
}
const reverse = new Map<string, MessageKey>();
for (const key of Object.keys(zh) as MessageKey[]) {
  reverse.set(zh[key], key);
  reverse.set(english[key], key);
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = (Object.keys(zh) as MessageKey[]).flatMap((key) => {
  if (!key.includes("{v")) return [];
  return [key, zh[key], english[key]].map((template) => {
    const names: string[] = [];
    const parts = template.split(/(\{\w+\})/g).map((part) => {
      if (/^\{\w+\}$/.test(part)) {
        names.push(part.slice(1, -1));
        return "([\\s\\S]*?)";
      }
      return escape(part);
    });
    return [key, new RegExp(`^${parts.join("")}$`), names] as const;
  });
});

export function riskLabel(risk: string) {
  switch (risk) {
    case "low":
      return t("低风险");
    case "medium":
      return t("中风险");
    case "high":
      return t("高风险");
    case "critical":
      return t("严重风险");
    default:
      return t("风险未知");
  }
}
