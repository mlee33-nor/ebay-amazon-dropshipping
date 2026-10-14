// Ask AI's model connector (Anthropic's Messages API) against a stand-in server: reading a question sends only the
// question text, a bad or slow reply is ignored, an unusable reply is asked once more, an unknown topic is never used.
import http from 'node:http';
import assert from 'node:assert/strict';

let reply = '{"topic":"profit","period":"august","compare_to":"","product":""}';
let delay = 0;
let status = 200;
const queue = []; // replies used before `reply`, one per request
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url, key: req.headers['x-api-key'], auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: queue.length ? queue.shift() : reply }], stop_reason: 'end_turn' }));
    }, delay);
  });
});
await new Promise((r) => mock.listen(0, r));
process.env.ANTHROPIC_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test'; // a stand-in: a real key in .env is never used by tests
process.env.DATABASE_URL = '';
const { routeQuestion, llmConfigured } = await import('../src/llm.js');

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };

await check('configured from ANTHROPIC_API_KEY', () => assert.equal(llmConfigured(), true));
await check('a question comes back as a topic and period', async () => {
  assert.deepEqual(await routeQuestion('how did we go in aug'), { topic: 'profit', period: 'august', compare_to: '', product: '' });
});
await check('only the question is sent, with the key in x-api-key, to /v1/messages', () => {
  const s = seen.at(-1);
  assert.equal(s.path, '/v1/messages');
  assert.equal(s.key, 'sk-ant-api03-test');
  assert.equal(s.auth, undefined);
  assert.equal(s.body.messages.length, 1);
  assert.equal(s.body.messages[0].content, 'how did we go in aug');
  assert.ok(!/\$\d/.test(JSON.stringify(s.body)), 'no money figures in the request');
});
await check('JSON wrapped in text or code fences still reads', async () => {
  reply = 'Sure!\n```json\n{"topic":"settlement","period":"","compare_to":"","product":""}\n```';
  assert.equal((await routeQuestion('what does he owe me')).topic, 'settlement');
});
await check('an unknown topic is ignored', async () => {
  reply = '{"topic":"stock_prices","period":"","compare_to":"","product":""}';
  assert.equal(await routeQuestion('x'), null);
});
await check('an error reply is ignored', async () => {
  status = 500;
  assert.equal(await routeQuestion('x'), null);
  status = 200;
});
await check('a slow model is cut off, not waited on', async () => {
  delay = 400;
  reply = '{"topic":"profit","period":"","compare_to":"","product":""}';
  const t0 = Date.now();
  assert.equal(await routeQuestion('x', { timeoutMs: 100 }), null);
  assert.ok(Date.now() - t0 < 350);
  delay = 0;
});

await check('an unusable reply is asked once more', async () => {
  const before = seen.length;
  queue.push('', '{"topic":"promotions","period":"","compare_to":"","product":""}');
  assert.equal((await routeQuestion('did the ads pay off')).topic, 'promotions');
  assert.equal(seen.length - before, 2);
});
await check('never more than two tries', async () => {
  const before = seen.length;
  reply = 'no idea';
  assert.equal(await routeQuestion('x'), null);
  assert.equal(seen.length - before, 2);
});

const { writeAnswer } = await import('../src/llm.js');
const facts = { text: '**Drew owes Myles $45.96** for October 2026.', bullets: ['Due Oct 26 (in 27 days)', 'Paid so far: $2,226.79'] };
await check('the model writes the answer from the facts when every number matches', async () => {
  reply = "Drew owes you **$45.96** for October, and it's due Oct 26.";
  assert.equal(await writeAnswer('what does drew owe me', facts), reply);
  const s = seen.at(-1);
  assert.match(s.body.messages[0].content, /\$45\.96/, 'the facts are sent to write from');
});
await check('a written answer with a made-up number is thrown away (the dashboard\'s wording is used)', async () => {
  reply = 'Drew owes you about $46 for October.';
  const before = seen.length;
  assert.equal(await writeAnswer('what does drew owe me', facts), null);
  assert.equal(seen.length - before, 2, 'asked twice, then gave up');
});
await check('thinking tags from reasoning models are removed', async () => {
  reply = '<think>45.96 plus 10 is 55.96</think>Drew owes you $45.96.';
  assert.equal(await writeAnswer('what does drew owe me', facts), 'Drew owes you $45.96.');
});

// ---- Headers, model choice, retries and the key's spelling, against a second stand-in
const ant = [];
let antReply = { content: [{ type: 'text', text: '{"topic":"refunds","period":"september","compare_to":"","product":""}' }], stop_reason: 'end_turn' };
let antStatus = 200;
const anthropic = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    ant.push({ path: req.url, workspace: req.headers['anthropic-workspace-id'], key: req.headers['x-api-key'], version: req.headers['anthropic-version'], auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(antStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(antReply));
  });
});
await new Promise((r) => anthropic.listen(0, r));
process.env.ANTHROPIC_API_BASE = 'http://127.0.0.1:' + anthropic.address().port;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
delete process.env.ANTHROPIC_MODEL;
await check('with an Anthropic key, Anthropic answers (Messages API, x-api-key, version header, Sonnet 5.5 by default)', async () => {
  const before = seen.length;
  assert.deepEqual(await routeQuestion('refunds in sept?'), { topic: 'refunds', period: 'september', compare_to: '', product: '' });
  const r = ant.at(-1);
  assert.equal(r.path, '/v1/messages');
  assert.equal(r.key, 'sk-ant-test');
  assert.equal(r.version, '2023-06-01');
  assert.equal(r.auth, undefined, 'the key goes in x-api-key only');
  assert.equal(r.body.model, 'claude-sonnet-5-5');
  assert.equal(r.body.temperature, undefined, 'no temperature: current models reject it (400)');
  assert.equal(r.body.output_config?.effort, 'low');
  assert.ok(r.body.max_tokens >= 8000, 'room for thinking as well as the reply');
  assert.equal(r.body.fallbacks, 'default');
  assert.ok(r.body.system && r.body.messages.every((m) => m.role !== 'system'), 'the system prompt is in "system"');
});
await check('ANTHROPIC_WORKSPACE_ID is sent as anthropic-workspace-id (organization-level keys need it)', async () => {
  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_test';
  await routeQuestion('refunds in sept?');
  assert.equal(ant.at(-1).workspace, 'wrkspc_test');
  delete process.env.ANTHROPIC_WORKSPACE_ID;
  await routeQuestion('refunds in sept?');
  assert.equal(ant.at(-1).workspace, undefined, 'not sent when not set');
});
await check('ANTHROPIC_MODEL picks the model', async () => {
  process.env.ANTHROPIC_MODEL = 'claude-haiku-5-5';
  await routeQuestion('refunds in sept?');
  assert.equal(ant.at(-1).body.model, 'claude-haiku-5-5');
  delete process.env.ANTHROPIC_MODEL;
});
await check('an Anthropic error is retried once and gives up cleanly', async () => {
  const n = ant.length;
  antStatus = 529;
  assert.equal(await routeQuestion('refunds in sept?'), null);
  assert.equal(ant.length - n, 2, 'two tries');
  antStatus = 200;
});
await check('spaces, a line break or quotes pasted around the key are dropped', async () => {
  process.env.ANTHROPIC_API_KEY = '  "sk-ant-api03-pasted"\n';
  await routeQuestion('refunds in sept?');
  assert.equal(ant.at(-1).key, 'sk-ant-api03-pasted');
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
});
await check('a reply cut off at max_tokens is not used', async () => {
  antReply = { content: [{ type: 'text', text: '{"topic":"refu' }], stop_reason: 'max_tokens' };
  assert.equal(await routeQuestion('refunds in sept?'), null);
});
await check('the key also works saved under another spelling (anthropic_Api), and ANTHROPIC_API_KEY wins when defined', async () => {
  antReply = { content: [{ type: 'text', text: '{"topic":"refunds","period":"september","compare_to":"","product":""}' }], stop_reason: 'end_turn' };
  delete process.env.ANTHROPIC_API_KEY;
  process.env.anthropic_Api = 'sk-ant-alias';
  await routeQuestion('refunds in sept?');
  assert.equal(ant.at(-1).key, 'sk-ant-alias');
  process.env.ANTHROPIC_API_KEY = '';
  const n = ant.length;
  await routeQuestion('refunds in sept?');
  assert.equal(ant.length, n, 'an empty ANTHROPIC_API_KEY turns Anthropic off');
  delete process.env.anthropic_Api;
});
anthropic.close();
process.env.ANTHROPIC_API_KEY = '';

mock.close();
console.log(failed ? '\nLLM: FAILED' : '\nLLM: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
