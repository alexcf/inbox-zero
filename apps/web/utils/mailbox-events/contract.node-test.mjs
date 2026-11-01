import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { signedRequest } from "./received.ts";

const receiverSource = process.env.TASKHUB_RECEIVER_SOURCE;
test("producer signature and retry interoperate with Python receiver", { skip: !receiverSource }, () => {
  const secret = "synthetic-only";
  const timestamp = 1700000000;
  const signed = signedRequest({ accountId: "synthetic-account", url: "https://example.test", secret }, { eventId: "synthetic-event", accountId: "synthetic-account", messageId: "synthetic-message", threadId: "synthetic-thread" }, timestamp * 1000);
  const code = `
import json, os, sys, tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import inboxzero_webhook_receiver as receiver
sample = json.load(sys.stdin)
with tempfile.TemporaryDirectory(dir=os.path.realpath(tempfile.gettempdir())) as temp:
    root = Path(temp)
    (root / 'secret').write_text(sample['secret'])
    (root / 'accounts').write_text(json.dumps(['synthetic-account']))
    with patch.object(receiver, 'MAILBOX_EVENTS_SECRET_FILE', root / 'secret'), patch.object(receiver, 'MAILBOX_EVENTS_ACCOUNTS_FILE', root / 'accounts'), patch.object(receiver, 'MAILBOX_EVENTS_STATE_DIR', root / 'state'):
        body = sample['body'].encode()
        status, first = receiver.handle_mailbox_event(sample['headers'], body, now=sample['timestamp'])
        assert status == 202 and first['duplicate'] is False
        status, second = receiver.handle_mailbox_event(sample['headers'], body, now=sample['timestamp'])
        assert status == 202 and second['duplicate'] is True
        status, _ = receiver.handle_mailbox_event(sample['headers'], body + b' ', now=sample['timestamp'])
        assert status == 401
`;
  const result = spawnSync("/usr/bin/python3", ["-c", code, receiverSource], { input: JSON.stringify({ secret, timestamp, ...signed }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
