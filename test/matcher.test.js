import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePair } from '../src/matcher.js';

const eb = { created_at: '2026-09-20T18:00:00Z', ship_name: 'Jane Okafor', ship_city: 'Houston', ship_state: 'TX', ship_zip: '77002', tracking_numbers: [], titles: ['Ninja Blender 1000W'], revenue: 110 };
const az = (o) => ({ order_date: '2026-09-20', shipText: '', zip: null, state: null, total: 80, tracking: [], titles: [], ...o });

test('email-style order (first name + city + state) auto-link evidence', () => {
  const s = scorePair(az({ shipText: 'Jane HOUSTON, TX', state: 'TX' }), eb);
  assert.ok(s.evidence);
  assert.ok(s.score >= 70, `score ${s.score}`);
});

test('same first name but different city is not evidence', () => {
  const s = scorePair(az({ shipText: 'Jane MESA, AZ', state: 'AZ' }), eb);
  assert.equal(s.evidence, false);
});

test('personal purchase to my own address never has evidence', () => {
  const s = scorePair(az({ shipText: 'Sam SPRINGFIELD, IL', state: 'CA', titles: ['Ninja Blender 1000W'] }), eb);
  assert.equal(s.evidence, false);
});

test('implausible price blocks the auto-link threshold', () => {
  const s = scorePair(az({ shipText: 'Jane HOUSTON, TX', state: 'TX', total: 400 }), eb);
  assert.ok(s.score < 70, `score ${s.score}`);
});

test('zip + last name (CSV style) links', () => {
  const s = scorePair(az({ shipText: 'Jane Okafor 1 Oak St HOUSTON, TX 77002', zip: '77002' }), eb);
  assert.ok(s.evidence && s.score >= 70);
});

test('outside the date window is never scored', () => {
  assert.equal(scorePair(az({ order_date: '2026-10-05' }), eb), null);
});

test('email-style order bought 3 days after the sale still auto-links', () => {
  const s = scorePair(az({ order_date: '2026-09-23', shipText: 'Jane HOUSTON, TX', state: 'TX' }), eb);
  assert.ok(s.evidence && s.score >= 70, `score ${s.score}`);
});

test('short titles never produce a title match (regression: "Item 2" vs email placeholder)', async () => {
  const { titleSimilarity } = await import('../src/matcher.js');
  assert.equal(titleSimilarity('Kitchen (1 item, title not in email)', 'Item 2'), 0);
  assert.ok(titleSimilarity('Ninja Professional Blender 1000W Pitcher', 'Ninja Blender 1000W Professional') > 0.7);
});

test('a high score without a tracking match is never "strong"', () => {
  const s = scorePair(az({ shipText: 'Jane Okafor 1 Oak St HOUSTON, TX 77002', zip: '77002', titles: ['Ninja Blender 1000W Pro'] }), eb);
  assert.ok(s.score >= 100);
  assert.equal(s.strong, false);
});
