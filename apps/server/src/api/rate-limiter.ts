import type { RequestHandler } from 'express';

export interface TokenBucketPolicy {
  /** Maximum burst size. */
  capacity: number;
  /** Tokens restored per second. */
  refillPerSecond: number;
  /** Window shown in RateLimit-Policy, in seconds. */
  windowSeconds: number;
}

interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

const MAX_BUCKETS = 10_000;

/** A process-local token bucket limiter keyed by Express's resolved client IP. */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly name: string,
    private readonly policy: TokenBucketPolicy,
  ) {}

  readonly middleware: RequestHandler = (request, response, next) => {
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = this.consume(ip, now);
    const remaining = Math.floor(bucket.tokens);
    const resetSeconds = Math.ceil(
      Math.max(0, this.policy.capacity - bucket.tokens) / this.policy.refillPerSecond,
    );

    response.setHeader(
      'RateLimit-Policy',
      `${this.policy.capacity};w=${this.policy.windowSeconds}`,
    );
    response.setHeader('RateLimit-Limit', String(this.policy.capacity));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(resetSeconds));

    if (!bucket.allowed) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil(bucket.retryAfterMs / 1000))));
      response.status(429).json({
        error: {
          code: 'rate_limit_exceeded',
          message: `Too many requests for the ${this.name} endpoint group. Try again shortly.`,
        },
      });
      return;
    }

    next();
  };

  private consume(
    key: string,
    now: number,
  ): TokenBucket & { allowed: boolean; retryAfterMs: number } {
    const existing = this.buckets.get(key);
    const elapsedSeconds = existing ? Math.max(0, now - existing.updatedAt) / 1000 : 0;
    const available = existing
      ? Math.min(
          this.policy.capacity,
          existing.tokens + elapsedSeconds * this.policy.refillPerSecond,
        )
      : this.policy.capacity;
    const allowed = available >= 1;
    const tokens = allowed ? available - 1 : available;
    const entry = { tokens, updatedAt: now };

    // Refresh insertion order so capacity eviction removes the least recently used client.
    this.buckets.delete(key);
    this.buckets.set(key, entry);
    if (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest) this.buckets.delete(oldest);
    }

    return {
      ...entry,
      allowed,
      retryAfterMs: allowed ? 0 : ((1 - available) / this.policy.refillPerSecond) * 1000,
    };
  }
}

export const API_RATE_LIMIT: TokenBucketPolicy = {
  capacity: 240,
  refillPerSecond: 4,
  windowSeconds: 60,
};

export const ANALYTICS_RATE_LIMIT: TokenBucketPolicy = {
  capacity: 30,
  refillPerSecond: 0.5,
  windowSeconds: 60,
};

export const INTEGRATION_TEST_RATE_LIMIT: TokenBucketPolicy = {
  capacity: 5,
  refillPerSecond: 5 / 60,
  windowSeconds: 60,
};
