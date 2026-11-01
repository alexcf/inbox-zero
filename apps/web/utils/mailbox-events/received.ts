import { createHash, createHmac, randomUUID } from "node:crypto";

type Config = { accountId: string; url: string; secret: string };
export function receivedConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config | null {
  if (env.MAILBOX_RECEIVED_ENABLED !== "true") return null;
  const {
    MAILBOX_RECEIVED_ACCOUNT_ID: accountId,
    MAILBOX_RECEIVED_URL: url,
    MAILBOX_RECEIVED_SECRET: secret,
  } = env;
  if (!accountId || !url || !secret)
    throw new Error("Incomplete mailbox received configuration");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid mailbox received URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error("Invalid mailbox received URL");
  return { accountId, url, secret };
}

export function receivedId(accountId: string, messageId: string) {
  return `received-${createHash("sha256")
    .update(JSON.stringify([accountId, messageId]))
    .digest("hex")}`;
}

type History = {
  messagesAdded?:
    | {
        message?: {
          id?: string | null;
          threadId?: string | null;
          labelIds?: string[] | null;
        } | null;
      }[]
    | null;
};
export function receivedMessages(history: History[]) {
  const messages = new Map<string, { messageId: string; threadId: string }>();
  for (const h of history)
    for (const item of h.messagesAdded ?? []) {
      const m = item.message;
      if (!m || !Array.isArray(m.labelIds))
        throw new Error("Incomplete received history labels");
      const labels = m.labelIds;
      if (
        !labels.includes("INBOX") ||
        labels.includes("DRAFT") ||
        labels.includes("SENT")
      )
        continue;
      if (!m?.id || !m.threadId)
        throw new Error("Incomplete received history message");
      const old = messages.get(m.id);
      if (old && old.threadId !== m.threadId)
        throw new Error("Conflicting received history message");
      messages.set(m.id, { messageId: m.id, threadId: m.threadId });
    }
  return [...messages.values()];
}

export function signedRequest(
  config: Config,
  row: {
    eventId: string;
    accountId: string;
    messageId: string;
    threadId: string;
  },
  now = Date.now(),
) {
  const body = JSON.stringify({
    version: 1,
    eventId: row.eventId,
    type: "message.received",
    account: { id: row.accountId, provider: "google" },
    data: { messageId: row.messageId, threadId: row.threadId },
  });
  const timestamp = String(Math.floor(now / 1000));
  const signature = `v1=${createHmac("sha256", config.secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-InboxZero-Timestamp": timestamp,
      "X-InboxZero-Event-Id": row.eventId,
      "X-InboxZero-Signature": signature,
    },
  };
}

export function leaseToken() {
  return randomUUID();
}
