import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { receivedConfig, receivedId, receivedMessages, signedRequest } from "./received.ts";

test("defaults off and rejects incomplete or unsafe enabled configuration", () => {
  assert.equal(receivedConfig({}), null);
  assert.throws(() => receivedConfig({ MAILBOX_RECEIVED_ENABLED: "true" }));
  assert.throws(() => receivedConfig({ MAILBOX_RECEIVED_ENABLED: "true", MAILBOX_RECEIVED_ACCOUNT_ID: "acct", MAILBOX_RECEIVED_SECRET: "synthetic", MAILBOX_RECEIVED_URL: "http://example.test" }));
});

test("selects only received inbox additions and rejects incomplete identities", () => {
  const msg = (id, labelIds) => ({ message: { id, threadId: "thread", labelIds } });
  assert.deepEqual(receivedMessages([{ messagesAdded: [msg("in", ["INBOX"]), msg("in", ["INBOX"]), msg("sent", ["SENT", "INBOX"]), msg("draft", ["DRAFT", "INBOX"]), msg("archive", ["IMPORTANT"])] }]), [{ messageId: "in", threadId: "thread" }]);
  assert.throws(() => receivedMessages([{ messagesAdded: [{ message: { id: "in", labelIds: ["INBOX"] } }] }]));
});

test("stable scoped event identity and fresh signatures over identical retry body", () => {
  const eventId = receivedId("acct", "message");
  assert.equal(eventId, receivedId("acct", "message"));
  assert.notEqual(eventId, receivedId("other", "message"));
  const config = { accountId: "acct", url: "https://example.test", secret: "synthetic" };
  const row = { eventId, accountId: "acct", messageId: "message", threadId: "thread" };
  const first = signedRequest(config, row, 1000000);
  const retry = signedRequest(config, row, 1001000);
  assert.equal(first.body, retry.body);
  assert.notEqual(first.headers["X-InboxZero-Signature"], retry.headers["X-InboxZero-Signature"]);
  assert.equal(first.headers["X-InboxZero-Signature"], `v1=${createHmac("sha256", "synthetic").update(`1000.${first.body}`).digest("hex")}`);
});
