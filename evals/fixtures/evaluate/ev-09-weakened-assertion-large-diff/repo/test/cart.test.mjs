import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalCents } from '../src/cart.mjs';

test('sums line totals', () => {
  assert.equal(totalCents([{ priceCents: 250, qty: 2 }, { priceCents: 100, qty: 1 }]), 600);
});

test('an empty cart is free', () => {
  assert.equal(totalCents([]), 0);
});

test('rounds each line half up', () => {
  assert.equal(totalCents([{ priceCents: 105, qty: 0.5 }]), 53);
});
