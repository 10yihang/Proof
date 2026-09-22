import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const now = new Date("2026-09-22T12:00:00Z").getTime();

describe("relativeTime", () => {
  it("uses seconds within a minute, then minutes and hours", () => {
    expect(relativeTime(new Date(now - 5_000), now)).toMatch(/秒|second/);
    expect(relativeTime(new Date(now - 3 * 60_000), now)).toMatch(/3/);
    expect(relativeTime(new Date(now - 5 * 3_600_000), now)).toMatch(/5/);
  });
  it("uses days within a week, then falls back to a date", () => {
    // numeric:"auto" 在中文下输出「前天」，英文输出 "2 days ago"。
    expect(relativeTime(new Date(now - 2 * 86_400_000), now)).toMatch(/2|前天/);
    const old = relativeTime(new Date(now - 30 * 86_400_000), now);
    expect(old).toMatch(/8|月|Aug/);
  });
});
