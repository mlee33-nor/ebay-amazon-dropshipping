// Fixtures mirror the real Amazon templates (Sep 2026) with personal details replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonEmail } from '../src/email.js';

const ISO = '⁦', PDI = '⁩', RLE = '‫', CGJ = '͏';

test('order confirmation, current template (first name - CITY, ST, "12.6 USD")', () => {
  const text = `Your Orders\n\n    Jane, thanks for your order!\nOrdered\n\nShipped\n\nArriving Thursday\n\nJane - HOUSTON, TX\n\nOrder #\n${RLE}113-2483158-9253037\n\nView or edit order\nhttps://www.amazon.com/your-orders/order-details?orderID=113-2483158-9253037\n\nGrand Total:\n12.6 USD\n\n©2026 Amazon.com`;
  const p = parseAmazonEmail({ subject: `Ordered 1 item: Crafts${CGJ} ${CGJ}`, text, html: '<td>Grand Total:</td><td>$12.60</td>', date: '2026-09-22T19:19:20Z' });
  assert.equal(p.kind, 'order');
  assert.deepEqual(p.orderIds, ['113-2483158-9253037']);
  assert.equal(p.total, 12.6);
  assert.equal(p.shipName, 'Jane');
  assert.equal(p.shipCity, 'HOUSTON');
  assert.equal(p.state, 'TX');
  assert.equal(p.category, 'Crafts');
  assert.equal(p.itemCount, 1);
});

test('order confirmation, "Ordered: 1 X item" subject with bidi isolates', () => {
  const p = parseAmazonEmail({ subject: `Ordered: ${ISO}2${PDI} Exercise & Fitness items`, text: 'Mark - MESA, AZ\nOrder #\n114-0000001-0000002\nGrand Total:\n$1,204.99' });
  assert.equal(p.kind, 'order');
  assert.equal(p.itemCount, 2);
  assert.equal(p.category, 'Exercise & Fitness');
  assert.equal(p.total, 1204.99);
  assert.equal(p.shipCity, 'MESA');
});

test('refund issued', () => {
  const text = 'Hello Jane, Your refund was issued. $106.67 will be credited to your Visa by Sep 27.\nView refund summary (https://www.amazon.com/spr/returns/prep?orderId=114-8894232-8142646)\n\nReturn summary\n\nRefund subtotal $106.67\nTotal refund $106.67\n\nQuantity: 1 Order # 114-8894232-8142646 Reason for return: Not as Expected\nProducts related to your return\nSomething else\n $12.99';
  const p = parseAmazonEmail({ subject: 'Refund issued for AC Infinity Through Wall Fan 6....', text });
  assert.equal(p.kind, 'refund');
  assert.deepEqual(p.orderIds, ['114-8894232-8142646']);
  assert.equal(p.refund, 106.67);
  assert.equal(p.itemTitle, 'AC Infinity Through Wall Fan 6');
});

test('shipping delay and marketing mail are not orders', () => {
  assert.equal(parseAmazonEmail({ subject: `Delay in shipping your order ${ISO}#114-0935486-5216212${PDI}`, text: 'x' }).kind, 'shipment');
  assert.equal(parseAmazonEmail({ subject: 'Deals picked for you', text: 'x' }).kind, 'other');
});

test('forwarded Amazon order email uses the original send date', () => {
  const text = `---------- Forwarded message ---------\nFrom: Amazon.com <auto-confirm@amazon.com>\nDate: Tue, Sep 22, 2026 at 12:14 PM\nSubject: Ordered 1 item: Camera & Photo\nTo: <old@example.com>\n\nThanks for your order!\n\nKeisha - ATLANTA, GA\n\nOrder #\n114-5555555-6666666\n\nGrand Total:\n16.19 USD`;
  const p = parseAmazonEmail({ subject: 'Fwd: Ordered 1 item: Camera & Photo', text, date: '2026-09-23T03:00:00Z' });
  assert.equal(p.kind, 'order');
  assert.equal(p.forwarded, true);
  assert.equal(p.fromAmazon, true);
  assert.equal(p.total, 16.19);
  assert.equal(p.shipCity, 'ATLANTA');
  assert.ok(p.originalDate && p.originalDate.startsWith('2026-09-22'));
});

test('a forward that is not from Amazon is ignored', () => {
  const p = parseAmazonEmail({ subject: 'Fwd: Ordered pizza', text: '---------- Forwarded message ---------\nFrom: Pizza Place <hi@pizza.test>\nDate: Tue, Sep 22, 2026 at 12:14 PM\nOrder #\n114-5555555-6666666\nGrand Total:\n$20.00' });
  assert.equal(p.fromAmazon, false);
});

test('Gmail-forwarded HTML Amazon email with *bold* and inline links still reads the total', () => {
  const text = '---------- Forwarded message ---------\nFrom: Amazon.com <auto-confirm@amazon.com>\nDate: Tue, Sep 22, 2026 at 3:00 PM\nSubject: Ordered: 1 Camera item\n\n   Your Orders\n<https://www.amazon.com/gp/r.html?C=3E92&U=https%3A%2F%2Fwww.amazon.com>\n\nEzra - ATLANTA, GA\n\nOrder #\n*111-6656473-0336252*\n<https://www.amazon.com/your-orders/order-details?orderID=111-6656473-0336252>\n\nGrand Total:\n*$16.19*\n';
  const p = parseAmazonEmail({ subject: 'Fwd: Ordered: 1 Camera item', text });
  assert.equal(p.total, 16.19);
  assert.deepEqual(p.orderIds, ['111-6656473-0336252']);
  assert.equal(p.shipCity, 'ATLANTA');
});
