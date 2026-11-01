CREATE TABLE "MailboxReceivedCheckpoint" (
  "accountId" TEXT PRIMARY KEY,
  "cursor" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MailboxReceivedCheckpoint_due_idx" ON "MailboxReceivedCheckpoint" ("state", "nextAttemptAt");

CREATE FUNCTION mailbox_enqueue_received(
  p_account TEXT, p_start TEXT, p_end TEXT, p_token TEXT, p_messages JSONB
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_cursor TEXT;
  v_message RECORD;
  v_affected INTEGER;
BEGIN
  SELECT "cursor" INTO v_cursor FROM "MailboxReceivedCheckpoint"
  WHERE "accountId" = p_account AND "state" = 'leased' AND "leaseToken" = p_token
  FOR UPDATE;
  IF v_cursor IS NULL OR v_cursor !~ '^[0-9]+$' OR
     p_start !~ '^[0-9]+$' OR p_end !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Mailbox received cursor unavailable';
  END IF;
  IF v_cursor::NUMERIC < p_start::NUMERIC THEN
    RAISE EXCEPTION 'Mailbox received history gap';
  END IF;
  FOR v_message IN
    SELECT * FROM jsonb_to_recordset(p_messages)
      AS item("eventId" TEXT, "messageId" TEXT, "threadId" TEXT)
  LOOP
    INSERT INTO "MailboxReceivedOutbox" ("eventId", "accountId", "messageId", "threadId")
    VALUES (v_message."eventId", p_account, v_message."messageId", v_message."threadId")
    ON CONFLICT ("accountId", "messageId") DO UPDATE SET "threadId" = EXCLUDED."threadId"
    WHERE "MailboxReceivedOutbox"."threadId" = EXCLUDED."threadId";
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION 'Conflicting received message identity';
    END IF;
  END LOOP;
  IF p_end::NUMERIC > v_cursor::NUMERIC THEN
    UPDATE "MailboxReceivedCheckpoint" SET "cursor" = p_end, "updatedAt" = NOW()
    WHERE "accountId" = p_account AND "leaseToken" = p_token;
  END IF;
  RETURN 'ok';
END;
$$;
