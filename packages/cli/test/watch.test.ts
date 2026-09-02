import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OBSERVATORIO } from '../../ingest/src/observatorio.ts';
import { rewrittenAfterClose } from '../src/watch.ts';

/**
 * The case that produced a false finding on 2026-09-02.
 *
 * August's archive was rewritten at 13:04 UTC on 31 August — eleven hours
 * before the month ended, which is the ordinary last daily refresh. Because the
 * previous check had asked "is this month over now?" and the run happened on
 * 2 September, it reported a closed month rewritten with 261,243 records added.
 */
test('the last daily refresh of the month is not a rewrite', () => {
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202608', '20260831T130427Z'), false);
});

test('a copy written after the month closed is a rewrite', () => {
  // 2026-08-10 rewrote June and July, which is the real finding shape.
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202607', '20260810T213129Z'), true);
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202606', '20260810T213129Z'), true);
});

test('the grace covers a refresh that lands just into the next month', () => {
  // The publisher's daily job can run after midnight on the 1st without that
  // being a revision of the month it just closed.
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202608', '20260901T130000Z'), false);
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202608', '20260902T130000Z'), false);
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202608', '20260905T130000Z'), true);
});

test('an unparseable stamp is not reported as a finding', () => {
  // 'unknown' is what compactStamp returns when Last-Modified is absent.
  // Guessing true there would manufacture findings out of missing headers.
  assert.equal(rewrittenAfterClose(OBSERVATORIO, '202608', 'unknown'), false);
});
