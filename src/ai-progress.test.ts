import { describe, expect, it } from "vitest";
import { advanceAiProgress, startAiProgress } from "./ai-progress";

describe("Agent activity", () => {
  it("coalesces file capture and bounds activity without resetting elapsed time", () => {
    let state = startAiProgress(100);
    for (let n = 0; n < 1000; n++) {
      state = advanceAiProgress(
        state,
        { phase: "preparing", path: `${n}.ts`, completed: n, total: 1000 },
        200 + n,
      );
    }
    expect(state.history).toHaveLength(1);
    expect(state.activity.completed).toBe(999);
    for (let n = 0; n < 100; n++)
      state = advanceAiProgress(
        state,
        { phase: "reading", path: `${n}.ts` },
        2000 + n,
      );
    expect(state.history).toHaveLength(40);
    expect(state.startedAt).toBe(100);
    expect(state.lastEventAt).toBe(2099);
  });
});
