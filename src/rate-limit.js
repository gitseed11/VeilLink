const MAX_IP_BUCKETS = 20000;
const MAX_KEY_BUCKETS = 1000;

export class SlidingWindowLimiter {
  constructor({ now = Date.now } = {}) {
    // API-key buckets are small and security-sensitive. Keep them in a
    // separate map so a flood of client-IP buckets cannot evict them and
    // reset the per-key request budget.
    this.keyBuckets = new Map();
    this.securityBuckets = new Map();
    this.ipBuckets = new Map();
    this.now = now;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    this.cleanupTimer.unref?.();
  }

  mapsFor(id) {
    const value = String(id);
    if (value.startsWith('key:')) {
      return { buckets: this.keyBuckets, max: MAX_KEY_BUCKETS };
    }
    if (value.startsWith('authfail:') || value.startsWith('adminlogin:')) {
      return { buckets: this.securityBuckets, max: MAX_IP_BUCKETS };
    }
    return { buckets: this.ipBuckets, max: MAX_IP_BUCKETS };
  }

  take(id, limit, windowMs) {
    const now = this.now();
    const cutoff = now - windowMs;
    const { buckets, max } = this.mapsFor(id);
    let bucket = buckets.get(id);
    if (!bucket) {
      if (buckets.size >= max) {
        buckets.delete(buckets.keys().next().value);
      }
      bucket = [];
      buckets.set(id, bucket);
    }
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    if (bucket.length >= limit) {
      const retryAfterMs = Math.max(1000, bucket[0] + windowMs - now);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000), stamp: null };
    }
    bucket.push(now);
    return { allowed: true, retryAfterSeconds: 0, stamp: now };
  }

  refund(id, stamp) {
    if (stamp === null || stamp === undefined) return;
    const { buckets } = this.mapsFor(id);
    const bucket = buckets.get(id);
    if (!bucket) return;
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      if (bucket[index] === stamp) {
        bucket.splice(index, 1);
        break;
      }
    }
    if (!bucket.length) buckets.delete(id);
  }

  blocked(id, limit, windowMs) {
    const { buckets } = this.mapsFor(id);
    const bucket = buckets.get(id);
    if (!bucket) return false;
    const cutoff = this.now() - windowMs;
    while (bucket.length && bucket[0] <= cutoff) bucket.shift();
    return bucket.length >= limit;
  }

  cleanup() {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const buckets of [this.keyBuckets, this.securityBuckets, this.ipBuckets]) {
      for (const [id, bucket] of buckets) {
        while (bucket.length && bucket[0] <= cutoff) bucket.shift();
        if (!bucket.length) buckets.delete(id);
      }
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
