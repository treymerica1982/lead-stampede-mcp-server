/**
 * In-process IP-based token bucket rate limiter.
 *
 * Designed for the public (unauthenticated) discovery endpoints.
 * Simple, zero-dependency, good enough for single-instance deployments.
 * For multi-instance, swap to Redis-backed or Cloudflare-level limiting.
 */

const DEFAULT_MAX_TOKENS = 60;     // requests per window
const DEFAULT_REFILL_MS = 60_000;  // 1 minute window
const CLEANUP_INTERVAL_MS = 5 * 60_000; // purge stale buckets every 5 min

class TokenBucket {
  constructor(max, refillMs) {
    this.max = max;
    this.refillMs = refillMs;
    this.buckets = new Map(); // ip -> { tokens, lastRefill }
  }

  consume(ip) {
    const now = Date.now();
    let bucket = this.buckets.get(ip);

    if (!bucket) {
      bucket = { tokens: this.max - 1, lastRefill: now };
      this.buckets.set(ip, bucket);
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.refillMs) {
      const refills = Math.floor(elapsed / this.refillMs);
      bucket.tokens = Math.min(this.max, bucket.tokens + refills * this.max);
      bucket.lastRefill += refills * this.refillMs;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      // If bucket has been idle for 2+ windows, remove it
      if (now - bucket.lastRefill > this.refillMs * 2) {
        this.buckets.delete(ip);
      }
    }
  }
}

const bucket = new TokenBucket(DEFAULT_MAX_TOKENS, DEFAULT_REFILL_MS);

// Periodic cleanup to prevent unbounded memory growth
setInterval(() => bucket.cleanup(), CLEANUP_INTERVAL_MS).unref();

/**
 * Express middleware — apply to public routes.
 * Returns 429 if the caller exceeds the rate limit.
 */
export function publicRateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!bucket.consume(ip)) {
    return res.status(429).json({
      error: 'rate_limited',
      message: 'Too many requests. Please slow down.',
      retry_after_seconds: Math.ceil(DEFAULT_REFILL_MS / 1000),
    });
  }

  next();
}
