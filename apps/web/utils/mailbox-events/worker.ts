import prisma from "@/utils/prisma";
import { leaseToken, receivedConfig, signedRequest } from "./received";

type Row = {
  eventId: string;
  accountId: string;
  messageId: string;
  threadId: string;
  attempts: number;
};

export async function deliverReceivedOutbox() {
  const config = receivedConfig();
  if (!config) return { enabled: false, processed: 0 };
  let processed = 0;
  // Three five-second requests leave headroom for the database and cron runtime.
  for (let i = 0; i < 3; i++) {
    const token = leaseToken();
    const rows = await prisma.$queryRaw<Row[]>`
      UPDATE "MailboxReceivedOutbox" SET "state" = 'leased', "leaseToken" = ${token},
        "leaseUntil" = NOW() + INTERVAL '2 minutes', "attempts" = "attempts" + 1
      WHERE "eventId" = (
        SELECT "eventId" FROM "MailboxReceivedOutbox"
        WHERE "accountId" = ${config.accountId} AND
          (("state" = 'pending' AND "nextAttemptAt" <= NOW()) OR ("state" = 'leased' AND "leaseUntil" < NOW()))
        ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1
      ) RETURNING "eventId", "accountId", "messageId", "threadId", "attempts"`;
    const row = rows[0];
    if (!row) break;
    let state = "pending";
    try {
      const request = signedRequest(config, row);
      const response = await fetch(config.url, {
        method: "POST",
        ...request,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 202) state = "delivered";
      else if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429
      )
        state = "held";
    } catch {
      // Unknown delivery outcomes retry with the same event ID and body.
    }
    const delaySeconds = Math.min(
      3600,
      30 * 2 ** Math.min(row.attempts - 1, 7),
    );
    await prisma.$executeRaw`
      UPDATE "MailboxReceivedOutbox" SET "state" = ${state}, "leaseToken" = NULL, "leaseUntil" = NULL,
        "nextAttemptAt" = NOW() + (${delaySeconds} * INTERVAL '1 second')
      WHERE "eventId" = ${row.eventId} AND "state" = 'leased' AND "leaseToken" = ${token}`;
    processed++;
  }
  return { enabled: true, processed };
}
