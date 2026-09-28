// Hosted AI model connector (OpenAI-compatible, e.g. FreeLLMAPI) against a mock server: it only ever receives the
// question text, a bad or slow reply is ignored, and an unknown topic is never used.
import http from 'node:http';
import assert from 'node:assert/strict';

let reply = '{"topic":"profit","period":"august","compare_to":"","product":""}';
let delay = 0;
let status = 200;
const seen = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    }, delay);
  });
});
await new Promise((r) => mock.listen(0, r));
process.env.AI_API_BASE = `http://127.0.0.1:${mock.address().port}/v1/`;
process.env.AI_API_KEY = 'test-key';
process.env.DATABASE_URL = '';
const { routeQuestion, llmConfigured } = await import('../src/llm.js');

let failed = false;
const check = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); } catch (e) { failed = true; console.log(`  FAIL  ${label}\n        ${e.message}`); } };

await check('configured from AI_API_BASE + AI_API_KEY', () => assert.equal(llmConfigured(), true));
await check('a question comes back as a topic and period', async () => {
  assert.deepEqual(await routeQuestion('how did we go in aug'), { topic: 'profit', period: 'august', compare_to: '', product: '' });
});
await check('only the question is sent, with the key as a bearer token, to /chat/completions', () => {
  const s = seen.at(-1);
  assert.equal(s.path, '/v1/chat/completions');
  assert.equal(s.auth, 'Bearer test-key');
  assert.equal(s.body.messages.length, 2);
  assert.equal(s.body.messages[1].content, 'how did we go in aug');
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

mock.close();
console.log(failed ? '\nLLM: FAILED' : '\nLLM: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
