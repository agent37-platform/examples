import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

// Start the app first. This uses a fresh visitor, provisions a real agent, and deletes it.
const base = process.env.DOTS_TEST_BASE_URL || 'http://localhost:3101';

test('one conversation survives concurrent tabs and caller-supplied session ids', { timeout: 300_000 }, async () => {
  let cookie;
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    });
    cookie ||= response.headers.get('set-cookie')?.split(';')[0];
    return response;
  }
  async function json(path, method, body) {
    const response = await request(path, method, body);
    const data = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function completed(response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const events = (await response.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      return event && data ? [{ event, data: JSON.parse(data) }] : [];
    });
    assert.ok(events.some(({ event }) => event === 'response.completed'), JSON.stringify(events.slice(-1)));
    return events.find(({ event }) => event === 'response.created').data.session_id;
  }

  await json('/api/me');
  try {
    await json('/api/agent', 'POST', { name: 'Chat continuity test', userName: 'Test visitor', timezone: 'UTC' });
    const deadline = Date.now() + 120_000;
    while (!(await json('/api/agent/ready')).ready) {
      assert.ok(Date.now() < deadline, 'Agent did not become ready');
      await delay(1000);
    }
    await json('/api/agent/setup', 'POST');
    assert.equal((await json('/api/chat')).session_id, null);

    const first = await request('/api/responses', 'POST', {
      input: 'For this test, reply with exactly: FIRST. Do not use any tools.',
    });
    const overlapping = await request('/api/responses', 'POST', {
      input: 'This overlapping request should be rejected.',
    });
    assert.equal(overlapping.status, 409);
    assert.equal((await overlapping.json()).error.code, 'session_busy');
    const sessionId = await completed(first);
    assert.equal((await json('/api/chat')).session_id, sessionId);

    // A stale tab, inbox reply, or custom caller cannot redirect the conversation.
    const second = await request('/api/responses', 'POST', {
      session_id: 'f'.repeat(32),
      replying_to: [],
      input: 'For this test, reply with exactly: SECOND. Do not use any tools.',
    });
    assert.equal(await completed(second), sessionId);
    const history = (await json(`/api/sessions/${sessionId}`)).history;
    assert.ok(history.some((message) => message.role === 'user' && message.content.includes('exactly: FIRST')));
    assert.ok(history.some((message) => message.role === 'user' && message.content.includes('exactly: SECOND')));
    assert.equal((await json('/api/chat')).session_id, sessionId);

    const duplicateIntro = await request('/api/responses', 'POST', { intro: true });
    assert.equal(duplicateIntro.status, 400);
    assert.equal((await json('/api/chat')).session_id, sessionId);
  } finally {
    if ((await json('/api/me')).agent) await json('/api/agent', 'DELETE');
  }
});
