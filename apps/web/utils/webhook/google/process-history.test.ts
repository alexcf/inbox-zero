import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hydrateReceivedLabels,
  processHistoryForUser,
} from "./process-history";
import { getHistory } from "@/utils/gmail/history";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import prisma from "@/utils/prisma";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import { createTestLogger } from "@/__tests__/helpers";
import { enqueueReceivedAndAdvance } from "@/utils/mailbox-events/store";

const logger = createTestLogger();

vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/utils/gmail/history", () => ({
  getHistory: vi.fn(),
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(),
  validateWebhookAccount: vi.fn(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("@/utils/error", () => ({
  isInvalidGrantError: vi.fn().mockReturnValue(false),
  captureException: vi.fn(),
}));

vi.mock("@/utils/mailbox-events/store", () => ({
  enqueueReceivedAndAdvance: vi.fn(),
}));

vi.mock("@/utils/email/rate-limit", () => ({
  getEmailProviderRateLimitState: vi.fn().mockResolvedValue(null),
  withRateLimitRecording: vi.fn(async (_context, operation) => operation()),
}));

describe("processHistoryForUser - 404 Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
  });

  it("should reset lastSyncedHistoryId when Gmail returns 404 (expired historyId)", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    // Simulate Gmail 404 error
    const error404 = new Error("Requested entity was not found");
    (error404 as any).status = 404;
    vi.mocked(getHistory).mockRejectedValue(error404);

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });

    // Verify lastSyncedHistoryId was updated to the current historyId via conditional update
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("should skip webhook history calls while account is in rate-limit mode", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue({
      provider: "google",
      retryAt: new Date(Date.now() + 60_000),
      source: "test",
    });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("should continue processing when rate-limit state lookup fails", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockRejectedValueOnce(
      new Error("redis unavailable"),
    );
    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).toHaveBeenCalled();
  });

  it("does not truncate moderate history ID gaps", async () => {
    const email = "user@test.com";
    const historyId = 1819;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "1000" }),
      expect.any(Object),
    );
  });

  it("advances cursor when large-gap history is truncated", async () => {
    const email = "user@test.com";
    const historyId = 5000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ startHistoryId: "2000" }),
      expect.any(Object),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("fetches all Gmail history pages before processing catch-up", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory)
      .mockResolvedValueOnce({
        history: [{ id: "1100", messagesAdded: [] }],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        history: [{ id: "1200", messagesAdded: [] }],
      });

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(getHistory).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        startHistoryId: "1000",
        maxResults: 500,
        pageToken: undefined,
      }),
      expect.any(Object),
    );
    expect(getHistory).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        startHistoryId: "1000",
        maxResults: 500,
        pageToken: "page-2",
      }),
      expect.any(Object),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("received Gmail history labels", () => {
  it("fetches minimal metadata when history has only identifiers", async () => {
    const history = [
      { messagesAdded: [{ message: { id: "synthetic", threadId: "thread" } }] },
    ];
    const get = vi
      .fn()
      .mockResolvedValue({ data: { threadId: "thread", labelIds: ["INBOX"] } });
    await hydrateReceivedLabels(history, {
      users: { messages: { get } },
    } as any);
    expect(get).toHaveBeenCalledWith({
      userId: "me",
      id: "synthetic",
      format: "minimal",
    });
    expect(history[0].messagesAdded[0].message).toMatchObject({
      labelIds: ["INBOX"],
    });
  });
  it("holds when current metadata cannot establish the original direction", async () => {
    const history = [
      { messagesAdded: [{ message: { id: "synthetic", threadId: "thread" } }] },
    ];
    const get = vi.fn().mockResolvedValue({
      data: { threadId: "thread", labelIds: ["IMPORTANT"] },
    });
    await expect(
      hydrateReceivedLabels(history, { users: { messages: { get } } } as any),
    ).rejects.toThrow();
  });
});

describe("configured received history retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MAILBOX_RECEIVED_ENABLED", "true");
    vi.stubEnv("MAILBOX_RECEIVED_ACCOUNT_ID", "synthetic-account");
    vi.stubEnv("MAILBOX_RECEIVED_URL", "https://example.test/receiver");
    vi.stubEnv("MAILBOX_RECEIVED_SECRET", "synthetic");
    const emailAccount = {
      id: "synthetic-account",
      email: "synthetic@example.test",
      lastSyncedHistoryId: "1000",
      account: {
        provider: "google",
        access_token: "synthetic",
        refresh_token: "synthetic",
      },
      rules: [],
    };
    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: { emailAccount, hasAutomationRules: false, hasAiAccess: false },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
  });
  it("returns 503 when outbox persistence fails", async () => {
    vi.mocked(getHistory).mockResolvedValue({ history: [] } as any);
    vi.mocked(enqueueReceivedAndAdvance).mockRejectedValueOnce(
      new Error("synthetic persistence failure"),
    );
    expect(
      (
        await processHistoryForUser(
          { emailAddress: "synthetic@example.test", historyId: 2000 },
          { receivedLease: { cursor: "1000", token: "synthetic-lease" } },
          logger,
        )
      ).status,
    ).toBe(503);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it("returns 503 for rate limit and expired history without advancing the cursor", async () => {
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue({
      provider: "google",
      retryAt: new Date(),
      source: "test",
    });
    expect(
      (
        await processHistoryForUser(
          { emailAddress: "synthetic@example.test", historyId: 2000 },
          { receivedLease: { cursor: "1000", token: "synthetic-lease" } },
          logger,
        )
      ).status,
    ).toBe(503);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
    const expired = Object.assign(new Error("synthetic"), { status: 404 });
    vi.mocked(getHistory).mockRejectedValue(expired);
    expect(
      (
        await processHistoryForUser(
          { emailAddress: "synthetic@example.test", historyId: 2000 },
          { receivedLease: { cursor: "1000", token: "synthetic-lease" } },
          logger,
        )
      ).status,
    ).toBe(503);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
