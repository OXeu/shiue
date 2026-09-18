import assert from 'node:assert/strict';
import test from 'node:test';
import { commentTime } from '../themes/xeu/assets/js/comment-time.js';

test('relative comment times use elapsed time and stop at exactly 72 hours', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  for (const [elapsed, expected] of [
    [0, '刚刚'], [59_999, '刚刚'], [60_000, '1 分钟前'], [180_000, '3 分钟前'],
    [3_600_000, '1 小时前'], [86_400_000, '1 天前'], [172_800_000, '2 天前'],
    [259_199_999, '2 天前'], [259_200_000, null], [345_600_000, null], [-60_000, null],
  ]) assert.equal(commentTime(new Date(now - elapsed).toISOString(), now).relative, expected);
  assert.equal(commentTime('invalid', now), null);
});

test('absolute comment times follow the local zone, date rollover, and DST', () => {
  const originalTZ = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    assert.equal(commentTime('2026-09-17T20:00:00Z').absolute, '2026-09-18 04:00');
    assert.equal(commentTime('2026-09-18T04:00:00+08:00').absolute, '2026-09-18 04:00');
    process.env.TZ = 'America/New_York';
    assert.equal(commentTime('2026-09-17T20:00:00Z').absolute, '2026-09-17 16:00');
    assert.equal(commentTime('2026-01-17T20:00:00Z').absolute, '2026-01-17 15:00');
    assert.equal(commentTime('2026-03-08T06:59:00Z').absolute, '2026-03-08 01:59');
    assert.equal(commentTime('2026-03-08T07:00:00Z').absolute, '2026-03-08 03:00');
    process.env.TZ = 'UTC';
    assert.equal(commentTime('2026-09-18T00:00:00Z').absolute, '2026-09-18 00:00');
  } finally {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  }
});
