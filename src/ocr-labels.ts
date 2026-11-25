import { t, type MessageKey } from "./i18n";

const reasons: Record<string, MessageKey> = {
  user_rule: "被审查规则排除",
  user_exclude: "被审查规则排除",
  default_path: "被 OCR 默认路径规则排除",
  extension: "文件类型暂不支持",
  unsupported_ext: "文件类型暂不支持",
  provider_directory: "依赖或生成目录",
  secret: "敏感路径",
  secret_exclude: "敏感路径",
  deleted: "文件已删除",
  binary: "二进制文件",
  too_large: "文件超出审查上限",
  no_net_change: "工作区版本没有净变更",
  timeout: "审查超时",
  budget: "达到审查预算",
};

export function ocrFileReason(reason?: string) {
  const label = reason && reasons[reason];
  return label ? t(label) : reason || t("OCR 跳过");
}
