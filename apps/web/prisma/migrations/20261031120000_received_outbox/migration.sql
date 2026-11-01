CREATE TABLE "MailboxReceivedOutbox" (
  "eventId" TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("accountId", "messageId")
);
CREATE INDEX "MailboxReceivedOutbox_due_idx" ON "MailboxReceivedOutbox" ("state", "nextAttemptAt");
