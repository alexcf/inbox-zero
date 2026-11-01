import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { processHistoryForUser } from "@/utils/webhook/google/process-history";
import { leaseToken, receivedConfig } from "./received";

type Checkpoint = {
  accountId: string;
  cursor: string;
  target: string;
  token: string;
  attempts: number;
  email: string;
};

export async function processReceivedCheckpoint() {
  const config = receivedConfig();
  if (!config) return { enabled: false, processed: 0 };
  const token = leaseToken();
  const rows = await prisma.$queryRaw<Checkpoint[]>`
    UPDATE "MailboxReceivedCheckpoint" SET
      "state" = 'leased', "leaseToken" = ${token},
      "leaseUntil" = NOW() + INTERVAL '10 minutes', "attempts" = "attempts" + 1
    WHERE "accountId" = ${config.accountId} AND
      (("state" = 'pending' AND "nextAttemptAt" <= NOW()) OR
       ("state" = 'leased' AND "leaseUntil" < NOW()))
    RETURNING "accountId", "cursor", "target", "leaseToken" AS token,
      "attempts", (SELECT email FROM "EmailAccount" WHERE id = ${config.accountId}) AS email`;
  const row = rows[0];
  if (!row) return { enabled: true, processed: 0 };
  const logger = createScopedLogger("mailbox-received-checkpoint");
  let success = false;
  try {
    if (!row.email || !/^\d+$/.test(row.cursor) || !/^\d+$/.test(row.target))
      throw new Error("Mailbox received checkpoint unavailable");
    if (BigInt(row.cursor) < BigInt(row.target)) {
      const received = await processHistoryForUser(
        { emailAddress: row.email, historyId: Number(row.target) },
        { receivedLease: { cursor: row.cursor, token } },
        logger,
      );
      if (received.status !== 200)
        throw new Error("Mailbox received history processing held");
    }
    const legacy = await processHistoryForUser(
      { emailAddress: row.email, historyId: Number(row.target) },
      { retryErrors: true },
      logger,
    );
    if (legacy.status !== 200) throw new Error("Mailbox rule processing held");
    success = true;
  } catch (error) {
    logger.error("Mailbox checkpoint processing failed", { error });
  }
  const delaySeconds = success
    ? 0
    : Math.min(3600, 30 * 2 ** Math.min(row.attempts - 1, 7));
  await prisma.$executeRaw`
    UPDATE "MailboxReceivedCheckpoint" AS checkpoint SET
      "state" = CASE WHEN ${success} AND
        CASE WHEN checkpoint."cursor" ~ '^[0-9]+$' AND
          checkpoint."target" ~ '^[0-9]+$' AND
          account."lastSyncedHistoryId" ~ '^[0-9]+$'
        THEN CAST(checkpoint."cursor" AS NUMERIC) >= CAST(checkpoint."target" AS NUMERIC) AND
          CAST(account."lastSyncedHistoryId" AS NUMERIC) >= CAST(checkpoint."target" AS NUMERIC)
        ELSE FALSE END
        THEN 'idle' ELSE 'pending' END,
      "leaseToken" = NULL, "leaseUntil" = NULL,
      "nextAttemptAt" = NOW() + (${delaySeconds} * INTERVAL '1 second'),
      "updatedAt" = NOW()
    FROM "EmailAccount" AS account
    WHERE checkpoint."accountId" = account.id AND
      checkpoint."accountId" = ${config.accountId} AND
      checkpoint."state" = 'leased' AND checkpoint."leaseToken" = ${token}`;
  return { enabled: true, processed: 1 };
}
