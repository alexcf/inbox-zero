import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// Opt in: creates an isolated local PostgreSQL cluster with synthetic data.
describe.skipIf(process.env.RUN_MAILBOX_POSTGRES_TESTS !== "1")(
  "received outbox PostgreSQL",
  () => {
    let dir: string;
    let data: string;
    let db: PrismaClient;
    let enqueue: typeof import("./store").enqueueReceivedAndAdvance;
    let worker: typeof import("./worker").deliverReceivedOutbox;
    const account = "synthetic-account";
    const history = [
      {
        messagesAdded: [
          {
            message: {
              id: "synthetic-message",
              threadId: "synthetic-thread",
              labelIds: ["INBOX"],
            },
          },
        ],
      },
    ];
    beforeAll(async () => {
      dir = mkdtempSync(join(realpathSync(tmpdir()), "received-test-"));
      data = join(dir, "data");
      execFileSync("initdb", ["-D", data, "-A", "trust", "--no-instructions"], {
        stdio: "ignore",
      });
      execFileSync(
        "pg_ctl",
        [
          "-D",
          data,
          "-o",
          `-k ${dir} -p 55439 -c listen_addresses=`,
          "-l",
          join(dir, "server.log"),
          "start",
        ],
        { stdio: "ignore" },
      );
      const connectionString = `postgresql://localhost/postgres?host=${encodeURIComponent(dir)}&port=55439`;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
      await db.$executeRawUnsafe(
        'CREATE TABLE "EmailAccount" ("id" TEXT PRIMARY KEY, "lastSyncedHistoryId" TEXT, "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW())',
      );
      const migration = readFileSync(
        "prisma/migrations/20261031120000_received_outbox/migration.sql",
        "utf8",
      );
      for (const statement of migration
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        await db.$executeRawUnsafe(statement);
      await db.$executeRaw`INSERT INTO "EmailAccount" ("id", "lastSyncedHistoryId") VALUES (${account}, '100')`;
      vi.doMock("@/utils/prisma", () => ({ default: db }));
      enqueue = (await import("./store")).enqueueReceivedAndAdvance;
      worker = (await import("./worker")).deliverReceivedOutbox;
    }, 15_000);
    afterAll(async () => {
      await db?.$disconnect();
      if (data)
        execFileSync("pg_ctl", ["-D", data, "stop", "-m", "fast"], {
          stdio: "ignore",
        });
      if (dir) rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.doUnmock("@/utils/prisma");
    });
    it("serializes overlapping windows and commits one stable outbox event", async () => {
      await Promise.all([
        enqueue(account, "100", "110", history),
        enqueue(account, "100", "120", history),
      ]);
      const accounts = await db.$queryRaw<
        { lastSyncedHistoryId: string }[]
      >`SELECT "lastSyncedHistoryId" FROM "EmailAccount" WHERE id = ${account}`;
      const rows = await db.$queryRaw<
        { eventId: string }[]
      >`SELECT "eventId" FROM "MailboxReceivedOutbox"`;
      expect(accounts[0].lastSyncedHistoryId).toBe("120");
      expect(rows).toHaveLength(1);
    });
    it("rolls back the outbox if cursor update fails", async () => {
      await db.$executeRawUnsafe(
        `CREATE FUNCTION fail_cursor_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER fail_cursor BEFORE UPDATE ON "EmailAccount" FOR EACH ROW EXECUTE FUNCTION fail_cursor_update()`,
      );
      try {
        const next = [
          {
            messagesAdded: [
              {
                message: {
                  id: "synthetic-second",
                  threadId: "synthetic-thread",
                  labelIds: ["INBOX"],
                },
              },
            ],
          },
        ];
        await expect(enqueue(account, "120", "130", next)).rejects.toThrow();
        const rows = await db.$queryRaw<
          { messageId: string }[]
        >`SELECT "messageId" FROM "MailboxReceivedOutbox"`;
        expect(rows).toEqual([{ messageId: "synthetic-message" }]);
      } finally {
        await db.$executeRawUnsafe(
          `DROP TRIGGER fail_cursor ON "EmailAccount"`,
        );
      }
    });
    it("holds a conflicting thread without advancing the cursor", async () => {
      const conflicting = [
        {
          messagesAdded: [
            {
              message: {
                id: "synthetic-message",
                threadId: "other-thread",
                labelIds: ["INBOX"],
              },
            },
          ],
        },
      ];
      await expect(enqueue(account, "120", "130", conflicting)).rejects.toThrow(
        "Conflicting received message identity",
      );
      const rows = await db.$queryRaw<
        { lastSyncedHistoryId: string }[]
      >`SELECT "lastSyncedHistoryId" FROM "EmailAccount" WHERE id = ${account}`;
      expect(rows[0].lastSyncedHistoryId).toBe("120");
    });
    it("leases only once across concurrent workers", async () => {
      vi.stubEnv("MAILBOX_RECEIVED_ENABLED", "true");
      vi.stubEnv("MAILBOX_RECEIVED_ACCOUNT_ID", account);
      vi.stubEnv("MAILBOX_RECEIVED_URL", "https://example.test/receiver");
      vi.stubEnv("MAILBOX_RECEIVED_SECRET", "synthetic");
      const fetchMock = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return new Response(null, { status: 202 });
      });
      vi.stubGlobal("fetch", fetchMock);
      await Promise.all([worker(), worker()]);
      const rows = await db.$queryRaw<
        { state: string; attempts: number }[]
      >`SELECT "state", "attempts" FROM "MailboxReceivedOutbox"`;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rows).toEqual([{ state: "delivered", attempts: 1 }]);
    });
    it("recovers an expired lease with the same event identity", async () => {
      await db.$executeRaw`UPDATE "MailboxReceivedOutbox" SET "state" = 'leased', "leaseToken" = 'expired', "leaseUntil" = NOW() - INTERVAL '1 second'`;
      const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
      vi.stubGlobal("fetch", fetchMock);
      await worker();
      const rows = await db.$queryRaw<
        { state: string; attempts: number }[]
      >`SELECT "state", "attempts" FROM "MailboxReceivedOutbox"`;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(rows).toEqual([{ state: "delivered", attempts: 2 }]);
    });
  },
);
