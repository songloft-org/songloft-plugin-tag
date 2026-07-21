/// <reference types="@songloft/plugin-sdk" />

// ============================================================
// 令牌桶限流器 — 保护 API 不被封禁
// ============================================================

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets: Record<string, Bucket> = {};

const DEFAULT_RATE = 2;      // 每秒允许的请求数
const DEFAULT_BURST = 5;     // 最大突发量

/**
 * 等待直到获取令牌
 * @param source  源名称（如 'netease', 'acoustid'）
 * @param rate    每秒允许的请求数（默认 2）
 * @param burst   最大突发量（默认 5）
 */
export async function rateLimitWait(source: string, rate = DEFAULT_RATE, burst = DEFAULT_BURST): Promise<void> {
  let b = buckets[source];
  if (!b) {
    b = { tokens: burst, lastRefill: Date.now() };
    buckets[source] = b;
  }

  // 循环：睡醒后重新补充并检查（多个 waiter 同时醒来时只有拿到令牌的才通过，不会超发）
  for (;;) {
    const now = Date.now();
    const elapsed = (now - b.lastRefill) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsed * rate);
    b.lastRefill = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    const waitMs = ((1 - b.tokens) / rate) * 1000;
    await new Promise(r => setTimeout(r, Math.ceil(waitMs)));
  }
}
