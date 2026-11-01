import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Load the actual modules with a transactional synthetic database; no network.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/utils/prisma") return { url: "data:text/javascript,export default globalThis.__mailboxTestPrisma", shortCircuit: true };
  if (specifier === "./received" && context.parentURL?.includes("mailbox-events")) return next("./received.ts", context);
  return next(specifier, context);
} });
const state = { cursor: "100", outbox: new Map(), fail: false };
globalThis.__mailboxTestPrisma = {
  async $transaction(fn) {
    const copy = { cursor: state.cursor, outbox: new Map(state.outbox) };
    const tx = {
      async $queryRaw() { return [{ lastSyncedHistoryId: copy.cursor }]; },
      async $executeRaw(strings, ...values) {
        const sql = strings.join("?");
        if (sql.includes("INSERT")) {
          if (state.fail) throw new Error("synthetic failure");
          const [eventId, accountId, messageId, threadId] = values;
          copy.outbox.set(`${accountId}:${messageId}`, { eventId, accountId, messageId, threadId });
        } else copy.cursor = values[0];
        return 1;
      },
    };
    await fn(tx);
    state.cursor = copy.cursor; state.outbox = copy.outbox;
  },
};
const { enqueueReceivedAndAdvance } = await import("./store.ts");
const history = [{ messagesAdded: [{ message: { id: "message", threadId: "thread", labelIds: ["INBOX"] } }] }];
test("enqueue and cursor commit together; failures and gaps do not advance", async () => {
  state.cursor = "100"; state.outbox = new Map(); state.fail = true;
  await assert.rejects(enqueueReceivedAndAdvance("acct", "100", "110", history));
  assert.equal(state.cursor, "100"); assert.equal(state.outbox.size, 0);
  state.fail = false;
  await assert.rejects(enqueueReceivedAndAdvance("acct", "101", "110", history));
  assert.equal(state.cursor, "100"); assert.equal(state.outbox.size, 0);
  await enqueueReceivedAndAdvance("acct", "100", "110", history);
  assert.equal(state.cursor, "110"); assert.equal(state.outbox.size, 1);
  await enqueueReceivedAndAdvance("acct", "100", "110", history);
  assert.equal(state.cursor, "110"); assert.equal(state.outbox.size, 1);
});
