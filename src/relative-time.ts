import { getLanguage } from "./i18n";

/** 历史栏相对时间：一分钟内"刚刚"，之后分/时/天，超过一周回落到日期。 */
export function relativeTime(
  date: string | number | Date,
  now = Date.now(),
): string {
  const then = new Date(date).getTime();
  const diff = then - now;
  const abs = Math.abs(diff);
  const locale = getLanguage();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  if (abs < 7 * 86_400_000)
    return rtf.format(Math.round(diff / 86_400_000), "day");
  return new Date(then).toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
