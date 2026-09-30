import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalCents } from '../src/cart.mjs';

test('per-line rounding is half up', () => {
  assert.equal(totalCents([{ priceCents: 105, qty: 0.5 }]), 53);
});
test('coupon', () => {
  assert.equal(totalCents([{ priceCents: 1000, qty: 2 }], { percentOff: 10 }), 1800);
  assert.equal(totalCents([{ priceCents: 333, qty: 1 }], { percentOff: 10 }), 300);
});
