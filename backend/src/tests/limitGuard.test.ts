// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = new Map<string, number>();
let mockRedisAvailable = true;
let mockRedisThrows = false;

const mockRedis = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  incrby: vi.fn(async (key: string, amount: number) => {
    if (mockRedisThrows) throw new Error("Connection timed out");
    const current = store.get(key) ?? 0;
    const updated = current + amount;
    store.set(key, updated);
    return updated;
  }),
  decrby: vi.fn(async (key: string, amount: number) => {
    if (mockRedisThrows) throw new Error("Connection timed out");
    const current = store.get(key) ?? 0;
    const updated = current - amount;
    store.set(key, updated);
    return updated;
  }),
  expire: vi.fn(async () => 1),
  pipeline: () => ({
    incrby: (key: string, amount: number) => {
      const current = store.get(key) ?? 0;
      store.set(key, current + amount);
      return {
        expire: () => ({
          exec: async () => [store.get(key), 1],
        }),
      };
    },
  }),
};

vi.mock("../lib/redis", () => ({
  getRedis: () => (mockRedisAvailable ? mockRedis : null),
}));

import {
  checkSpendingLimit,
  rollbackSpend,
  recordSpend,
  getCurrentSpend,
} from "../engine/limitGuard";

describe("Spending Limit Guard (Fail-Closed & TOCTOU Prevention)", () => {
  const USER_ID = "user-123-uuid";

  beforeEach(() => {
    store.clear();
    mockRedisAvailable = true;
    mockRedisThrows = false;
    vi.clearAllMocks();
  });

  describe("Fail-Closed on Redis Outage", () => {
    it("fails closed when user has a daily limit and Redis is unavailable", async () => {
      mockRedisAvailable = false;
      const res = await checkSpendingLimit(USER_ID, 10, 50, null);

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("unreachable");
      expect(res.reserved).toBe(false);
    });

    it("fails closed when user has a weekly limit and Redis is unavailable", async () => {
      mockRedisAvailable = false;
      const res = await checkSpendingLimit(USER_ID, 10, null, 100);

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("unreachable");
      expect(res.reserved).toBe(false);
    });

    it("fails closed when Redis throws an unexpected runtime error during limit check", async () => {
      mockRedisThrows = true;
      const res = await checkSpendingLimit(USER_ID, 10, 50, null);

      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("failing closed");
      expect(res.reserved).toBe(false);
    });

    it("permits transaction when user has NO limits configured even if Redis is unavailable", async () => {
      mockRedisAvailable = false;
      const res = await checkSpendingLimit(USER_ID, 50, null, null);

      expect(res.allowed).toBe(true);
      expect(res.reserved).toBe(false);
    });
  });

  describe("Atomic Reservation and Spend Enforcement", () => {
    it("allows spend and atomically reserves when within daily limit", async () => {
      const res = await checkSpendingLimit(USER_ID, 20, 50, null);

      expect(res.allowed).toBe(true);
      expect(res.reserved).toBe(true);

      const spend = await getCurrentSpend(USER_ID);
      expect(spend.dailySpendXLM).toBe(20);
    });

    it("blocks spend and rolls back reservation atomically when daily limit would be exceeded", async () => {
      // First spend: 30 XLM (limit: 50 XLM)
      const first = await checkSpendingLimit(USER_ID, 30, 50, null);
      expect(first.allowed).toBe(true);

      // Second spend: 25 XLM (30 + 25 = 55 > 50)
      const second = await checkSpendingLimit(USER_ID, 25, 50, null);
      expect(second.allowed).toBe(false);
      expect(second.reason).toContain("Daily limit of 50 XLM reached");

      // Verify rollback occurred: cumulative spend remains 30, not 55
      const spend = await getCurrentSpend(USER_ID);
      expect(spend.dailySpendXLM).toBe(30);

      // Subsequent valid spend of 20 XLM (30 + 20 = 50 <= 50) succeeds
      const third = await checkSpendingLimit(USER_ID, 20, 50, null);
      expect(third.allowed).toBe(true);

      const finalSpend = await getCurrentSpend(USER_ID);
      expect(finalSpend.dailySpendXLM).toBe(50);
    });

    it("blocks spend and rolls back when weekly limit is exceeded", async () => {
      // User with 100 XLM weekly limit
      const first = await checkSpendingLimit(USER_ID, 70, null, 100);
      expect(first.allowed).toBe(true);

      // Second spend: 40 XLM (70 + 40 = 110 > 100)
      const second = await checkSpendingLimit(USER_ID, 40, null, 100);
      expect(second.allowed).toBe(false);
      expect(second.reason).toContain("Weekly limit of 100 XLM reached");

      const spend = await getCurrentSpend(USER_ID);
      expect(spend.weeklySpendXLM).toBe(70);
    });
  });

  describe("Rollback on Transaction Failure", () => {
    it("releases reserved spend if caller invokes rollbackSpend", async () => {
      const check = await checkSpendingLimit(USER_ID, 15, 50, null);
      expect(check.allowed).toBe(true);

      let spend = await getCurrentSpend(USER_ID);
      expect(spend.dailySpendXLM).toBe(15);

      // Simulate transaction failure -> trigger rollback
      await rollbackSpend(USER_ID, 15);

      spend = await getCurrentSpend(USER_ID);
      expect(spend.dailySpendXLM).toBe(0);
    });
  });

  describe("TOCTOU Race Condition Prevention", () => {
    it("prevents concurrent requests from overspending the limit", async () => {
      const dailyLimit = 50;

      // Two concurrent requests of 30 XLM each against 50 XLM limit
      const [res1, res2] = await Promise.all([
        checkSpendingLimit(USER_ID, 30, dailyLimit, null),
        checkSpendingLimit(USER_ID, 30, dailyLimit, null),
      ]);

      // Exactly one must succeed and one must be blocked
      const successCount = [res1, res2].filter((r) => r.allowed).length;
      const blockedCount = [res1, res2].filter((r) => !r.allowed).length;

      expect(successCount).toBe(1);
      expect(blockedCount).toBe(1);

      // Cumulative spend must equal 30, never 60
      const spend = await getCurrentSpend(USER_ID);
      expect(spend.dailySpendXLM).toBe(30);
    });
  });
});
