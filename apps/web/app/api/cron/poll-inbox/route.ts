import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  getPremiumUserFilter,
  getUserTier,
  hasAiAccess,
  premiumEntitlementSelect,
} from "@/utils/premium";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { processHistoryForUser } from "@/utils/webhook/google/process-history";

export const maxDuration = 800;

// Polls Gmail for Google accounts that have NO active Pub/Sub watch
// (e.g. Workspace domains that block Gmail push). For each account we read the
// current historyId and run the same history-processing pipeline a push webhook
// would, so rules are applied without Pub/Sub. lastSyncedHistoryId is advanced
// by processHistoryForUser, so each poll only handles new messages.

export const GET = withError("cron/poll-inbox", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized cron request: api/cron/poll-inbox"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return pollInboxes(request.logger);
});

export const POST = withError("cron/poll-inbox", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/poll-inbox"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return pollInboxes(request.logger);
});

type PollResult = {
  emailAccountId: string;
  status: "bootstrapped" | "processed" | "skipped" | "error";
  message?: string;
};

async function pollInboxes(logger: Logger) {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      ...getPremiumUserFilter(),
      watchEmailsExpirationDate: null,
      account: { provider: "google", disconnectedAt: null },
    },
    select: {
      id: true,
      email: true,
      lastSyncedHistoryId: true,
      account: {
        select: {
          access_token: true,
          refresh_token: true,
          expires_at: true,
        },
      },
      user: {
        select: {
          aiApiKey: true,
          premium: { select: premiumEntitlementSelect },
        },
      },
    },
  });

  logger.info("Polling inboxes without a Pub/Sub watch", {
    count: emailAccounts.length,
  });

  const results: PollResult[] = [];

  for (const emailAccount of emailAccounts) {
    const log = logger.with({
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
    });

    try {
      const { account, user } = emailAccount;

      if (!hasAiAccess(getUserTier(user.premium), !!user.aiApiKey)) {
        results.push({
          emailAccountId: emailAccount.id,
          status: "skipped",
          message: "No AI access",
        });
        continue;
      }

      if (!account?.access_token || !account?.refresh_token) {
        results.push({
          emailAccountId: emailAccount.id,
          status: "skipped",
          message: "Missing authentication tokens",
        });
        continue;
      }

      const gmail = await getGmailClientWithRefresh({
        accessToken: account.access_token,
        refreshToken: account.refresh_token,
        expiresAt: account.expires_at?.getTime() || null,
        emailAccountId: emailAccount.id,
        logger: log,
      });

      const profile = await gmail.users.getProfile({ userId: "me" });
      const currentHistoryId = profile.data.historyId;

      if (!currentHistoryId) {
        results.push({
          emailAccountId: emailAccount.id,
          status: "skipped",
          message: "No historyId returned by getProfile",
        });
        continue;
      }

      // Bootstrap: record the current point and start processing from the next
      // poll, so we don't reprocess the entire mailbox backlog.
      if (!emailAccount.lastSyncedHistoryId) {
        await prisma.emailAccount.update({
          where: { id: emailAccount.id },
          data: { lastSyncedHistoryId: currentHistoryId.toString() },
        });
        log.info("Bootstrapped lastSyncedHistoryId", { currentHistoryId });
        results.push({
          emailAccountId: emailAccount.id,
          status: "bootstrapped",
        });
        continue;
      }

      await processHistoryForUser(
        {
          emailAddress: emailAccount.email,
          historyId: Number(currentHistoryId),
        },
        { startHistoryId: emailAccount.lastSyncedHistoryId },
        log,
      );

      results.push({ emailAccountId: emailAccount.id, status: "processed" });
    } catch (error) {
      log.error("Failed to poll inbox", { error });
      captureException(error, { emailAccountId: emailAccount.id });
      results.push({
        emailAccountId: emailAccount.id,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({ success: true, results });
}
