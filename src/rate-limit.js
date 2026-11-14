export class SlidingWindowLimiter {
  constructor({ now = Date.now } = {}) {
    this.buckets = new Map();
    this.now = now;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  take(id, limit, windowMs) {
    const now = this.now();
    const cutoff = now - windowMs;
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = [];
      this.buckets.set(id, bucket);
    }
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= limit) {
      const retryAfterMs = Math.max(1000, bucket[0] + windowMs - now);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }
    bucket.push(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  blocked(id, limit, windowMs) {
    const bucket = this.buckets.get(id);
    if (!bucket) return false;
    const cutoff = this.now() - windowMs;
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    return bucket.length >= limit;
  }

  cleanup() {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [id, bucket] of this.buckets) {
      while (bucket.length && bucket[0] <= cutoff) bucket.shift();
      if (!bucket.length) this.buckets.delete(id);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

export class ConcurrencyLimiter {
  constructor() {
    this.active = new Map();
  }

  acquire(id, limit) {
    const current = this.active.get(id) || 0;
    if (current >= limit) return false;
    this.active.set(id, current + 1);
    return true;
  }

  release(id) {
    const current = this.active.get(id) || 0;
    if (current <= 1) this.active.delete(id);
    else this.active.set(id, current - 1);
  }

  count(id) {
    return this.active.get(id) || 0;
  }
}
