// @ts-nocheck
/**
 * Spending Limit Guard
 *
 * Uses Redis INCRBY + EXPIRE to track cumulative spend per user
 * within a rolling daily / weekly window.
 *
 * Key pattern: limit:{userId}:daily:{YYYY-MM-DD}
 *              limit:{userId}:weekly:{YYYY-WW}
 *
 * Values are stored in Lumens (XLM) × 10_000_000 (integer micro-XLM)
 * to avoid float precision issues.
 */

import { getRedis } from "../lib/redis";

const MICRO = 10_000_000; // 1 XLM = 10_000_000 micro-XLM

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  reserved?: boolean;
}

function todayKey(userId: string): string {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `limit:${userId}:daily:${d}`;
}

function weekKey(userId: string): string {
  const now = new Date();
  // ISO week number
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(
    ((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7
  );
  return `limit:${userId}:weekly:${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Check whether executing `amountXLM` is allowed under the user's limits.
 *
 * Remediation for Security & TOCTOU:
 * 1. Fail Closed: If dailyLimit or weeklyLimit is set and Redis is unreachable or throws,
 *    we block the transaction instead of failing open, preventing unconstrained spend.
 * 2. Atomic Reservation: Uses atomic INCRBY on daily/weekly counters BEFORE execution.
 *    If the limit is exceeded, immediately rolls back (DECRBY) and returns allowed: false.
 *    This prevents concurrent transactions from bypassing limits via TOCTOU race conditions.
 * 3. Execution Rollback: If on-chain transaction execution fails, caller can invoke `rollbackSpend()`.
 */
export async function checkSpendingLimit(
  userId: string,
  amountXLM: number,
  dailyLimitXLM: number | null,
  weeklyLimitXLM: number | null
): Promise<LimitCheckResult> {
  if (!userId || isNaN(amountXLM) || amountXLM <= 0) {
    return { allowed: true, reserved: false };
  }

  const hasLimits = dailyLimitXLM !== null || weeklyLimitXLM !== null;
  const redis = getRedis();

  // Fail-closed security rule:
  // If user has configured limits, but Redis is unreachable, reject the transaction
  // to prevent unmonitored overspending during outages.
  if (!redis) {
    if (hasLimits) {
      return {
        allowed: false,
        reason: "Spending limit verification service is unreachable (failing closed for security)",
        reserved: false,
      };
    }
    // No limits configured — safe to proceed without Redis
    return { allowed: true, reserved: false };
  }

  const microAmount = Math.round(amountXLM * MICRO);
  const dk = todayKey(userId);
  const wk = weekKey(userId);

  try {
    // Atomically increment cumulative counters (INCRBY) up front to avoid TOCTOU races
    const [newDaily, newWeekly] = await Promise.all([
      redis.incrby(dk, microAmount),
      redis.incrby(wk, microAmount),
    ]);

    // Ensure TTL is set on tracking keys (25 hours for daily, 8 days for weekly)
    await Promise.all([
      redis.expire(dk, 60 * 60 * 25),
      redis.expire(wk, 60 * 60 * 24 * 8),
    ]);

    // Evaluate daily limit
    if (dailyLimitXLM !== null) {
      const dailyMicroLimit = Math.round(dailyLimitXLM * MICRO);
      if (newDaily > dailyMicroLimit) {
        // Exceeded: atomically rollback reservation
        await rollbackSpend(userId, amountXLM);
        const spentToday = Math.max(0, newDaily - microAmount) / MICRO;
        return {
          allowed: false,
          reason: `Daily limit of ${dailyLimitXLM} XLM reached (spent ${spentToday.toFixed(4)} XLM today, attempted ${amountXLM} XLM)`,
          reserved: false,
        };
      }
    }

    // Evaluate weekly limit
    if (weeklyLimitXLM !== null) {
      const weeklyMicroLimit = Math.round(weeklyLimitXLM * MICRO);
      if (newWeekly > weeklyMicroLimit) {
        // Exceeded: atomically rollback reservation
        await rollbackSpend(userId, amountXLM);
        const spentThisWeek = Math.max(0, newWeekly - microAmount) / MICRO;
        return {
          allowed: false,
          reason: `Weekly limit of ${weeklyLimitXLM} XLM reached (spent ${spentThisWeek.toFixed(4)} XLM this week, attempted ${amountXLM} XLM)`,
          reserved: false,
        };
      }
    }

    // Within limits and atomically reserved
    return { allowed: true, reserved: true };
  } catch (err: any) {
    console.error("[LimitGuard] Redis error during spending limit check:", err?.message);
    if (hasLimits) {
      // Fail-closed on Redis operation error when user has spending limits configured
      return {
        allowed: false,
        reason: `Spending limit verification error: ${err?.message ?? "Service error"} (failing closed for security)`,
        reserved: false,
      };
    }
    return { allowed: true, reserved: false };
  }
}

/**
 * Rollback a reserved spend. Call if transaction execution fails on-chain.
 */
export async function rollbackSpend(userId: string, amountXLM: number): Promise<void> {
  if (!userId || isNaN(amountXLM) || amountXLM <= 0) return;

  const redis = getRedis();
  if (!redis) return;

  const microAmount = Math.round(amountXLM * MICRO);
  const dk = todayKey(userId);
  const wk = weekKey(userId);

  try {
    const decr = (key: string, val: number) =>
      typeof redis.decrby === "function" ? redis.decrby(key, val) : redis.incrby(key, -val);

    await Promise.all([
      decr(dk, microAmount),
      decr(wk, microAmount),
    ]);
  } catch (err: any) {
    console.error(`[LimitGuard] Failed to rollback spend for user ${userId}:`, err?.message);
  }
}

/**
 * Record a completed spend directly.
 * Kept for backward compatibility or when a spend was not pre-reserved via checkSpendingLimit.
 */
export async function recordSpend(userId: string, amountXLM: number): Promise<void> {
  if (!userId || isNaN(amountXLM) || amountXLM <= 0) return;

  const redis = getRedis();
  if (!redis) return;

  const microAmount = Math.round(amountXLM * MICRO);
  const [dk, wk] = [todayKey(userId), weekKey(userId)];

  try {
    await Promise.all([
      redis
        .pipeline()
        .incrby(dk, microAmount)
        .expire(dk, 60 * 60 * 25)
        .exec(),
      redis
        .pipeline()
        .incrby(wk, microAmount)
        .expire(wk, 60 * 60 * 24 * 8)
        .exec(),
    ]);
  } catch (err: any) {
    console.error(`[LimitGuard] Failed to record spend for user ${userId}:`, err?.message);
  }
}

/**
 * Get current cumulative spend for today and this week in XLM.
 */
export async function getCurrentSpend(userId: string): Promise<{ dailySpendXLM: number; weeklySpendXLM: number }> {
  const redis = getRedis();
  if (!redis || !userId) {
    return { dailySpendXLM: 0, weeklySpendXLM: 0 };
  }

  try {
    const [rawDaily, rawWeekly] = await Promise.all([
      redis.get<number>(todayKey(userId)),
      redis.get<number>(weekKey(userId)),
    ]);

    const parseVal = (v: any) => {
      if (typeof v === "number") return Math.max(0, v / MICRO);
      if (typeof v === "string") return Math.max(0, parseInt(v, 10) / MICRO);
      return 0;
    };

    return {
      dailySpendXLM: parseVal(rawDaily),
      weeklySpendXLM: parseVal(rawWeekly),
    };
  } catch {
    return { dailySpendXLM: 0, weeklySpendXLM: 0 };
  }
}
