import prisma from "@/utils/prisma";
import { receivedId, receivedMessages } from "./received";
import type { gmail_v1 } from "@googleapis/gmail";

// The row lock serializes concurrent history windows for this account. Never
// advance over a window whose start is newer than the committed cursor.
export async function enqueueReceivedAndAdvance(
  accountId: string,
  start: string,
  end: string,
  history: gmail_v1.Schema$History[],
) {
  const messages = receivedMessages(history);
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ lastSyncedHistoryId: string | null }[]>`
      SELECT "lastSyncedHistoryId" FROM "EmailAccount" WHERE id = ${accountId} FOR UPDATE`;
    const current = rows[0]?.lastSyncedHistoryId;
    if (
      !current ||
      !/^\d+$/.test(current) ||
      !/^\d+$/.test(start) ||
      !/^\d+$/.test(end)
    )
      throw new Error("Mailbox received cursor unavailable");
    if (BigInt(current) < BigInt(start))
      throw new Error("Mailbox received history gap");
    for (const { messageId, threadId } of messages) {
      const eventId = receivedId(accountId, messageId);
      const affected = await tx.$executeRaw`
        INSERT INTO "MailboxReceivedOutbox" ("eventId", "accountId", "messageId", "threadId")
        VALUES (${eventId}, ${accountId}, ${messageId}, ${threadId})
        ON CONFLICT ("accountId", "messageId") DO UPDATE SET "threadId" = EXCLUDED."threadId"
        WHERE "MailboxReceivedOutbox"."threadId" = EXCLUDED."threadId"`;
      if (affected !== 1)
        throw new Error("Conflicting received message identity");
    }
    if (BigInt(end) > BigInt(current))
      await tx.$executeRaw`
      UPDATE "EmailAccount" SET "lastSyncedHistoryId" = ${end}, "updatedAt" = NOW() WHERE id = ${accountId}`;
  });
}
