import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/utils/prisma") return { url: "data:text/javascript,export default globalThis.__workerPrisma", shortCircuit: true };
  if (specifier === "./received" && context.parentURL?.includes("mailbox-events")) return next("./received.ts", context);
  return next(specifier, context);
} });
let row = null;
let queue = [];
let settled = null;
globalThis.__workerPrisma = {
  async $queryRaw(_strings, _token, account) {
    const candidate = row ?? queue.shift();
    if (!candidate || candidate.accountId !== account) return [];
    row = null; return [candidate];
  },
  async $executeRaw(_strings, state, _delay, _eventId, _token) { settled = state; },
};
const { deliverReceivedOutbox } = await import("./worker.ts");
const source = { eventId: "received-example", accountId: "acct", messageId: "msg", threadId: "thread", attempts: 1 };
test("worker retries unknown outcomes, accepts 202, holds permanent failures and scopes account", async () => {
  Object.assign(process.env, { MAILBOX_RECEIVED_ENABLED: "true", MAILBOX_RECEIVED_ACCOUNT_ID: "acct", MAILBOX_RECEIVED_URL: "https://example.test/events", MAILBOX_RECEIVED_SECRET: "synthetic" });
  const originalFetch = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (_url, request) => { bodies.push(request.body); throw new Error("unknown outcome"); };
    row = { ...source }; await deliverReceivedOutbox(); assert.equal(settled, "pending");
    globalThis.fetch = async (_url, request) => { bodies.push(request.body); return new Response(null, { status: 202 }); };
    row = { ...source, attempts: 2 }; await deliverReceivedOutbox(); assert.equal(settled, "delivered");
    assert.equal(bodies[0], bodies[1]);
    globalThis.fetch = async () => new Response(null, { status: 403 });
    row = { ...source }; await deliverReceivedOutbox(); assert.equal(settled, "held");
    row = { ...source, accountId: "other" }; assert.equal((await deliverReceivedOutbox()).processed, 0);
    process.env.MAILBOX_RECEIVED_ENABLED = "false";
    assert.equal((await deliverReceivedOutbox()).enabled, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["MAILBOX_RECEIVED_ENABLED", "MAILBOX_RECEIVED_ACCOUNT_ID", "MAILBOX_RECEIVED_URL", "MAILBOX_RECEIVED_SECRET"]) delete process.env[key];
  }
});

test("limits a run to three deliveries and gives each a timeout signal", async () => {
  Object.assign(process.env, { MAILBOX_RECEIVED_ENABLED: "true", MAILBOX_RECEIVED_ACCOUNT_ID: "acct", MAILBOX_RECEIVED_URL: "https://example.test/events", MAILBOX_RECEIVED_SECRET: "synthetic" });
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  let calls = 0;
  try {
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return originalTimeout(ms); };
    row = null;
    queue = Array.from({ length: 5 }, (_, index) => ({ ...source, eventId: `event-${index}` }));
    globalThis.fetch = async (_url, request) => { calls++; assert.ok(request.signal instanceof AbortSignal); return new Response(null, { status: 202 }); };
    assert.equal((await deliverReceivedOutbox()).processed, 3);
    assert.equal(calls, 3);
    assert.deepEqual(timeouts, [5000, 5000, 5000]);
    assert.equal(queue.length, 2);
  } finally {
    queue = [];
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    for (const key of ["MAILBOX_RECEIVED_ENABLED", "MAILBOX_RECEIVED_ACCOUNT_ID", "MAILBOX_RECEIVED_URL", "MAILBOX_RECEIVED_SECRET"]) delete process.env[key];
  }
});
