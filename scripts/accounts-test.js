// Accounts (eBay stores): each account's sales, costs, payments and settings live in its own schema and never mix.
// Throwaway database; never touches real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-acct-'));
process.env.LOCAL_PG_DIR = dir;
process.env.LOCAL_PG_PORT = String(5470 + Number(process.env.TEST_PG_OFFSET || 0));
delete process.env.DATABASE_URL;
process.env.EMAIL_USER = 'main@example.com';
process.env.EMAIL_USER_SECONDSTORE = 'second@example.com';
const db = await import('../src/db.js');
const { initDb, q, closeDb, setSetting, getSetting, withAccount, currentAccount, createAccount, listAccounts, renameAccount, accountEnv, MAIN } = db;
const { normalizeOrder, upsertOrder } = await import('../src/ebay.js');
const { buildDataset, buildBooks } = await import('../src/dataset.js');
await initDb();

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };
const order = (id, title, price) => upsertOrder(normalizeOrder({
  orderId: id, creationDate: '2027-02-05T19:00:00Z', orderFulfillmentStatus: 'FULFILLED', cancelStatus: { cancelState: 'NONE_REQUESTED' },
  pricingSummary: { priceSubtotal: { value: String(price) }, total: { value: String(price) } }, totalMarketplaceFee: { value: '5' }, paymentSummary: { refunds: [] },
  fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: 'A Buyer', contactAddress: { city: 'Mesa', stateOrProvince: 'AZ' } } } }],
  lineItems: [{ lineItemId: `${id}-1`, title, quantity: 1, lineItemCost: { value: String(price) }, total: { value: String(price) } }],
}));

await setSetting('business_start', '2027-01');
await order('MAIN-1', 'Main Store Lamp', 40);
const second = await createAccount('Second Store');

await check('a new account gets its own id and shows in the list after the main one (MDBIZ MAIN)', async () => {
  assert.equal(second.id, 'secondstore');
  const list = await listAccounts();
  assert.deepEqual(list.map((a) => [a.id, a.name]), [[MAIN, 'MDBIZ MAIN'], ['secondstore', 'Second Store']]);
});

await withAccount(second.id, async () => {
  await setSetting('business_start', '2027-01');
  await order('SECOND-1', 'Second Store Mug', 25);
  await q("insert into expenses (month, category, amount, paid_by) values ('2027-02', 'Second store sub', 9, 'seller')");
});

await check('each account sees only its own sales', async () => {
  const main = await buildDataset();
  const sec = await withAccount(second.id, () => buildDataset());
  assert.deepEqual(main.map((o) => o.order_id), ['MAIN-1']);
  assert.deepEqual(sec.map((o) => o.order_id), ['SECOND-1']);
});
await check('costs, payments and settings are per account', async () => {
  const mainBooks = await buildBooks();
  const secBooks = await withAccount(second.id, () => buildBooks());
  assert.equal(mainBooks.expenses.length, 0);
  assert.deepEqual(secBooks.expenses.map((e) => e.category), ['Second store sub']);
  await withAccount(second.id, () => setSetting('split_amazon', 60));
  assert.equal(await getSetting('split_amazon'), null, 'the main account keeps its own split');
});
await check('the context follows awaits, and code that names no account works on the main one', async () => {
  assert.equal(currentAccount(), MAIN);
  const seen = await withAccount(second.id, async () => { await new Promise((r) => setTimeout(r, 5)); return currentAccount(); });
  assert.equal(seen, second.id);
  const [a, b] = await Promise.all([withAccount(MAIN, () => buildDataset()), withAccount(second.id, () => buildDataset())]);
  assert.deepEqual([a.length, b.length, a[0].order_id, b[0].order_id], [1, 1, 'MAIN-1', 'SECOND-1'], 'two accounts at once never mix');
});
await check('each account reads its own inbox settings (EMAIL_USER, EMAIL_USER_<ID>)', async () => {
  assert.equal(accountEnv('EMAIL_USER'), 'main@example.com');
  assert.equal(await withAccount(second.id, () => accountEnv('EMAIL_USER')), 'second@example.com');
});
await check('accounts can be renamed (the main one too); a second account with the same name gets its own id', async () => {
  await renameAccount(MAIN, 'MDBIZ MAIN STORE');
  const again = await createAccount('Second Store');
  assert.equal(again.id, 'secondstore2');
  assert.deepEqual((await listAccounts()).map((a) => a.name), ['MDBIZ MAIN STORE', 'Second Store', 'Second Store']);
});
await check('an account comes back after a restart with its data', async () => {
  await closeDb();
  await initDb();
  assert.deepEqual((await withAccount('secondstore', () => buildDataset())).map((o) => o.order_id), ['SECOND-1']);
});

await closeDb();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? '\nACCOUNTS: FAILED' : '\nACCOUNTS: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
