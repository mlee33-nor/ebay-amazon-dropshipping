// Hosted AI model connector (OpenAI-compatible, e.g. FreeLLMAPI) against a mock server: it only ever receives the
// question text, a bad or slow reply is ignored, an unusable reply is asked once more, an unknown topic is never used,
// and with AI_PROXY set the request goes through that proxy (Tailscale on Railway).
import http from 'node:http';
import net from 'node:net';
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
    seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: queue.length ? queue.shift() : reply } }] }));
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

// A small HTTP proxy standing in for Tailscale's (CONNECT tunnels and plain forwarding)
const viaProxy = [];
const proxy = http.createServer((req, res) => {
  viaProxy.push(req.url);
  const u = new URL(req.url);
  const up = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(up);
});
proxy.on('connect', (req, sock, head) => {
  viaProxy.push(req.url);
  const [host, port] = req.url.split(':');
  const up = net.connect(Number(port), host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.destroy());
});
await new Promise((r) => proxy.listen(0, r));
await check('with AI_PROXY the request goes through the proxy', async () => {
  process.env.AI_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  reply = '{"topic":"settlement","period":"","compare_to":"","product":""}';
  assert.equal((await routeQuestion('what does drew owe')).topic, 'settlement');
  assert.ok(viaProxy.length >= 1, 'the proxy saw the request');
  assert.equal(seen.at(-1).auth, 'Bearer test-key');
  delete process.env.AI_PROXY;
});
proxy.close();
mock.close();
console.log(failed ? '\nLLM: FAILED' : '\nLLM: ALL CHECKS PASSED');
process.exitCode = failed ? 1 : 0;
