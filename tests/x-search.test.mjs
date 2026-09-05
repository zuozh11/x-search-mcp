import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const url = 'https://x.com/example/status/123';
const text = (answer, annotations = []) => ({ type: 'output_text', text: answer, annotations });
const message = (...content) => ({ type: 'message', content });
const citation = { type: 'url_citation', url, start_index: 14, end_index: 55, title: 'source' };
const completed = (...output) => ({ status: 'completed', output: [{ type: 'x_search_call', status: 'completed' }, ...output] });
let fixture, request, requestCount = 0, baseUrl, client, httpStatus = 200;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  request = { path: req.url, body: JSON.parse(body) };
  requestCount++;
  res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(fixture));
});
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  client = new Client({ name: 'regression', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: {
    XAI_API_KEY: 'offline-test', XAI_BASE_URL: baseUrl, XAI_MODEL: 'fixture-model', XAI_TIMEOUT: '5000',
  }, stderr: 'pipe' }));
});
after(async () => {
  await client?.close();
  await new Promise(resolve => server.close(resolve));
});
const search = (arguments_ = {}) => client.callTool({ name: 'x_search', arguments: { query: 'test', ...arguments_ } });

test('host receives joint-search guidance and requests only xAI X search with correct schema', async () => {
  fixture = completed(message(text(JSON.stringify({ answer: 'result', citations: [] }))));
  const result = await search({ allowed_x_handles: ['example'], from_date: '2026-09-01', to_date: '2026-09-05' });
  assert.equal(result.isError, false);
  assert.match(client.getInstructions(), /official Web Search/);
  assert.match(client.getInstructions(), /Web-only/);
  assert.equal(request.path, '/v1/responses');
  assert.equal(request.body.model, 'fixture-model');
  assert.deepEqual(request.body.reasoning, { effort: 'low' });
  assert.deepEqual(request.body.tools, [{ type: 'x_search', allowed_x_handles: ['example'], from_date: '2026-09-01', to_date: '2026-09-05' }]);
  const format = request.body.text.format;
  assert.equal(format.name, 'x_search_answer');
  assert.equal(format.schema.type, 'object');
  assert.equal(format.schema.schema, undefined);
  assert.equal(format.strict, true);
  assert.equal(request.body.tool_choice, undefined);
});

test('keeps later messages, multiple text blocks, and their citations', async () => {
  fixture = completed(message(text('Searching now…')), message(
    text(JSON.stringify({ answer: 'Final answer', citations: [] }), [citation]),
    text(JSON.stringify({ answer: 'More evidence', citations: [] }), [{ ...citation, url: url + '4' }]),
  ));
  const { structuredContent: result } = await search();
  assert.equal(result.answer, 'Searching now…\n\nFinal answer\n\nMore evidence');
  assert.deepEqual(result.citations, [url, url + '4']);
  assert.equal(result.search_performed, true);
});

test('decoded JSON with escapes and emoji never retains raw JSON citation offsets', async () => {
  const answer = `😀 "quoted"\nSee [post](${url})`;
  fixture = completed(message(text(JSON.stringify({ answer, citations: [url] }), [citation])));
  const { structuredContent: result } = await search();
  assert.equal(result.answer, answer);
  assert.equal(result.inline_citations[0].start_index, null);
  assert.equal(result.inline_citations[0].end_index, null);
  assert.equal(result.inline_citations[0].url, url);
});

test('model-written URLs alone are not verified citations or proof of search', async () => {
  fixture = { status: 'completed', output: [message(text(JSON.stringify({ answer: 'Unverified claim', citations: [url] })))] };
  const { structuredContent: result } = await search();
  assert.deepEqual(result.citations, []);
  assert.equal(result.search_performed, null);
});

test('HTTP 200 with incomplete, pending, missing status or response.error is not success', async () => {
  for (const response of [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    { status: 'in_progress' }, {},
    { status: 'completed', error: { message: 'upstream failed' } },
  ]) {
    fixture = { output: [message(text('partial evidence', [citation]))], ...response };
    const result = await search();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.answer, 'partial evidence');
    assert.equal(result.structuredContent.status, response.error ? 'failed' : 'incomplete');
  }
});

test('empty completed response fails; failed search attempts remain distinguishable', async () => {
  fixture = { status: 'completed', output: [{ type: 'x_search_call', status: 'failed' }] };
  const result = await search();
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.search_performed, false);
});

test('HTTP errors produce the same failure contract', async () => {
  fixture = { error: { message: 'fixture unavailable' } };
  httpStatus = 503;
  try {
    const result = await search();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'failed');
    assert.match(result.structuredContent.error, /503/);
  } finally { httpStatus = 200; }
});

test('raw response is opt-in; invalid filter combinations do not reach API', async () => {
  fixture = completed(message(text('answer')));
  assert.equal((await search()).structuredContent.raw_response, undefined);
  assert.deepEqual((await search({ include_raw_response: true })).structuredContent.raw_response, fixture);
  const count = requestCount;
  assert.equal((await search({ allowed_x_handles: ['a'], excluded_x_handles: ['b'] })).isError, true);
  assert.equal((await search({ from_date: '2026-02-30' })).isError, true);
  assert.equal(requestCount, count);
});

async function smoke() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke-test.ts'], {
    env: { PATH: process.env.PATH, XAI_API_KEY: 'offline-test', XAI_BASE_URL: baseUrl, XAI_MODEL: 'smoke-model', XAI_TIMEOUT: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { code, output };
}

test('smoke uses custom endpoint/model and fails on tool errors or unverified search', async () => {
  fixture = completed(message(text('answer', [citation])));
  const success = await smoke();
  assert.equal(success.code, 0, success.output);
  assert.equal(request.body.model, 'smoke-model');
  fixture = { status: 'incomplete', output: [] };
  const failure = await smoke();
  assert.notEqual(failure.code, 0, failure.output);
  assert.match(failure.output, /MCP error/);
  fixture = { status: 'completed', output: [message(text('answer'))] };
  assert.notEqual((await smoke()).code, 0);
});


test('Responses usage confirms X search even when CPA omits x_search_call output', async () => {
  for (const count of [1, 0]) {
    fixture = {
      status: 'completed', output: [message(text('answer', [citation]))],
      usage: { server_side_tool_usage_details: { x_search_calls: count, web_search_calls: 0 } },
    };
    assert.equal((await search()).structuredContent.search_performed, count > 0);
  }
});
