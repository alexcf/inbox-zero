import prisma from "@/utils/prisma";
import { receivedId, receivedMessages } from "./received";
import type { gmail_v1 } from "@googleapis/gmail";

// A webhook is acknowledged only after its target is durably recorded. The
// received cursor is independent of the legacy rule-processing cursor.
export async function captureReceivedNotification(
  accountId: string,
  historyId: number,
) {
  if (!Number.isSafeInteger(historyId) || historyId < 0)
    throw new Error("Invalid mailbox received history ID");
  const target = String(historyId);
  const rows = await prisma.$queryRaw<{ accountId: string }[]>`
    INSERT INTO "MailboxReceivedCheckpoint" ("accountId", "cursor", "target")
    SELECT id, "lastSyncedHistoryId", ${target} FROM "EmailAccount"
    WHERE id = ${accountId} AND "lastSyncedHistoryId" ~ '^[0-9]+$'
    ON CONFLICT ("accountId") DO UPDATE SET
      "target" = CASE
        WHEN CAST(EXCLUDED."target" AS NUMERIC) > CAST("MailboxReceivedCheckpoint"."target" AS NUMERIC)
        THEN EXCLUDED."target" ELSE "MailboxReceivedCheckpoint"."target" END,
      "state" = CASE WHEN "MailboxReceivedCheckpoint"."state" = 'idle' AND
        CAST(EXCLUDED."target" AS NUMERIC) > CAST("MailboxReceivedCheckpoint"."target" AS NUMERIC)
        THEN 'pending' ELSE "MailboxReceivedCheckpoint"."state" END,
      "nextAttemptAt" = CASE WHEN "MailboxReceivedCheckpoint"."state" = 'idle' AND
        CAST(EXCLUDED."target" AS NUMERIC) > CAST("MailboxReceivedCheckpoint"."target" AS NUMERIC)
        THEN NOW() ELSE "MailboxReceivedCheckpoint"."nextAttemptAt" END,
      "updatedAt" = NOW()
    RETURNING "accountId"`;
  if (rows.length !== 1) throw new Error("Mailbox received cursor unavailable");
}

// The row lock serializes concurrent history windows for this account. Never
// advance over a window whose start is newer than the committed cursor.
export async function enqueueReceivedAndAdvance(
  accountId: string,
  start: string,
  end: string,
  history: gmail_v1.Schema$History[],
  leaseToken: string,
) {
  const messages = receivedMessages(history).map(({ messageId, threadId }) => ({
    eventId: receivedId(accountId, messageId),
    messageId,
    threadId,
  }));
  await prisma.$queryRaw`
    SELECT mailbox_enqueue_received(${accountId}, ${start}, ${end}, ${leaseToken},
      CAST(${JSON.stringify(messages)} AS JSONB))`;
}
