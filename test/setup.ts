import { afterEach } from "vitest";

// DO console.log is forwarded async to vitest; yield so RPC can settle between tests.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
});
