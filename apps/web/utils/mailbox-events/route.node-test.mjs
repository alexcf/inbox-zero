import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/utils/mailbox-events/worker") return { url: "data:text/javascript,export const deliverReceivedOutbox = async () => ({enabled:true,processed:0})", shortCircuit: true };
  return next(specifier, context);
} });
const { GET } = await import("../../app/api/cron/mailbox-events/route.ts");
test("cron endpoint requires the configured bearer credential", async () => {
  process.env.CRON_SECRET = "synthetic";
  try {
    assert.equal((await GET(new Request("https://example.test"))).status, 401);
    assert.equal((await GET(new Request("https://example.test", { headers: { authorization: "Bearer synthetic" } }))).status, 200);
    delete process.env.CRON_SECRET;
    assert.equal((await GET(new Request("https://example.test"))).status, 401);
  } finally { delete process.env.CRON_SECRET; }
});
