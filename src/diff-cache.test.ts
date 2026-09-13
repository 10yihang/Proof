import { it, expect } from "vitest";
import { DiffCache } from "./diff-cache";
import { demoChanges, demoDiff } from "./demo";
import { fileKey } from "./types";
it("invalidates the changed side/file but preserves another cached diff", () => {
  const cache = new DiffCache(),
    [a, b] = demoChanges.files;
  const first = {
    ...demoChanges,
    fileVersions: { [fileKey(a)]: "a1", [fileKey(b)]: "b1" },
  };
  cache.put(first, a, demoDiff(a));
  cache.put(first, b, demoDiff(b));
  const next = {
    ...first,
    token: "new",
    fileVersions: { ...first.fileVersions, [fileKey(a)]: "a2" },
  };
  cache.retain(next);
  expect(cache.get(next, a)).toBeUndefined();
  expect(cache.get(next, b)?.path).toBe(b.path);
  expect(
    cache.get({ ...next, workspace: { ...next.workspace, id: "another" } }, b),
  ).toBeUndefined();
});
it("coalesces a pending read and releases failed requests for retry", async () => {
  const cache = new DiffCache(),
    file = demoChanges.files[0];
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error("temporary");
  };
  await Promise.allSettled([
    cache.read(demoChanges, file, fetch),
    cache.read(demoChanges, file, fetch),
  ]);
  expect(calls).toBe(1);
  await cache.read(demoChanges, file, async () => demoDiff(file));
});
