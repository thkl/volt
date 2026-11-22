import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { TokenBucketRateLimiter } from './rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows the configured burst and rejects requests after tokens are spent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const limiter = new TokenBucketRateLimiter('analytics', {
      capacity: 2,
      refillPerSecond: 0.5,
      windowSeconds: 60,
    });
    const first = makeRequest('client-a');
    const second = makeRequest('client-a');
    const blocked = makeRequest('client-a');

    limiter.middleware(first.request, first.response, first.next);
    limiter.middleware(second.request, second.response, second.next);
    limiter.middleware(blocked.request, blocked.response, blocked.next);

    expect(first.next).toHaveBeenCalledOnce();
    expect(second.next).toHaveBeenCalledOnce();
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.status).toHaveBeenCalledWith(429);
    expect(blocked.json).toHaveBeenCalledWith({
      error: {
        code: 'rate_limit_exceeded',
        message: 'Too many requests for the analytics endpoint group. Try again shortly.',
      },
    });
    expect(blocked.headers.get('Retry-After')).toBe('2');
    expect(blocked.headers.get('RateLimit-Remaining')).toBe('0');
  });

  it('refills tokens over time and keeps client buckets separate', () => {
    let now = 20_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const limiter = new TokenBucketRateLimiter('test', {
      capacity: 1,
      refillPerSecond: 1,
      windowSeconds: 1,
    });
    const firstA = makeRequest('client-a');
    limiter.middleware(firstA.request, firstA.response, firstA.next);

    const firstB = makeRequest('client-b');
    limiter.middleware(firstB.request, firstB.response, firstB.next);

    const blockedA = makeRequest('client-a');
    limiter.middleware(blockedA.request, blockedA.response, blockedA.next);
    now += 1_000;
    const refilledA = makeRequest('client-a');
    limiter.middleware(refilledA.request, refilledA.response, refilledA.next);

    expect(firstA.next).toHaveBeenCalledOnce();
    expect(firstB.next).toHaveBeenCalledOnce();
    expect(blockedA.status).toHaveBeenCalledWith(429);
    expect(refilledA.next).toHaveBeenCalledOnce();
  });
});

function makeRequest(ip: string) {
  const headers = new Map<string, string>();
  const next = vi.fn();
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const request = { ip, socket: { remoteAddress: ip } } as unknown as Request;
  const response = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    status,
    json,
  } as unknown as Response;
  return { request, response, headers, next, status, json };
}
