import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'http';
import { app } from '../src/app';

// Runs against mock mode (no API keys set) — every external service
// falls back to its built-in mock, so these run offline.
describe('Freekend API', () => {
  let server: Server;
  let base: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('GET /health returns ok', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.app, 'Freekend API');
  });

  it('GET /movies/trending returns mock movies', async () => {
    const res = await fetch(`${base}/movies/trending`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.ok(Array.isArray(body.results) && body.results.length > 0);
    assert.equal(body.mock, true);
    assert.ok(body.poster_base);
  });

  it('GET /movies/search requires q', async () => {
    const res = await fetch(`${base}/movies/search`);
    assert.equal(res.status, 400);
  });

  it('GET /movies/search?q=rrr finds RRR', async () => {
    const body: any = await (await fetch(`${base}/movies/search?q=rrr`)).json();
    assert.ok(body.results.some((m: any) => m.title === 'RRR'));
  });

  it('GET /movies/discover?genre=28 filters by genre', async () => {
    const body: any = await (await fetch(`${base}/movies/discover?genre=28`)).json();
    assert.ok(body.results.length > 0);
    assert.ok(body.results.every((m: any) => m.genre_ids.includes(28)));
  });

  it('GET /movies/2 returns Pushpa', async () => {
    const body: any = await (await fetch(`${base}/movies/2`)).json();
    assert.equal(body.title, 'Pushpa: The Rise');
  });

  it('GET /restaurants returns mock restaurants', async () => {
    const body: any = await (await fetch(`${base}/restaurants?city=hyderabad&cuisine=biryani`)).json();
    assert.ok(body.results.length > 0);
    assert.equal(body.mock, true);
  });

  it('GET /restaurants falls back for unknown city', async () => {
    const body: any = await (await fetch(`${base}/restaurants?city=atlantis`)).json();
    assert.ok(body.results.length > 0);
  });

  it('GET /events returns upcoming (not past) dates', async () => {
    const body: any = await (await fetch(`${base}/events?city=hyderabad`)).json();
    assert.ok(body.results.length > 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(body.results.every((e: any) => e.date >= today), 'all mock events are upcoming');
  });

  it('GET /events?category=Music filters', async () => {
    const body: any = await (await fetch(`${base}/events?category=Music`)).json();
    assert.ok(body.results.length > 0);
    assert.ok(body.results.every((e: any) => e.category === 'Music'));
  });

  it('POST /framebot/chat requires message', async () => {
    const res = await fetch(`${base}/framebot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);
  });

  it('POST /framebot/chat streams SSE in mock mode', async () => {
    const res = await fetch(`${base}/framebot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'plan my saturday', city: 'hyderabad' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.includes('data:'));
    assert.ok(text.includes('"done":true'));
  });

  it('unknown route returns 404 JSON', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body: any = await res.json();
    assert.equal(body.error, 'Route not found');
  });
});

describe('Freekend agent mode', () => {
  let server: Server;
  let base: string;

  async function postChatSSE(body: any) {
    const res = await fetch(`${base}/framebot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const out = {
      text: '',
      plans: [] as any[],
      done: false,
      sessionId: null as string | null,
      errors: [] as string[],
    };
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const json: any = JSON.parse(t.slice(5).trim());
      if (json.text) out.text += json.text;
      if (json.plan) out.plans.push(json.plan);
      if (json.done) {
        out.done = true;
        out.sessionId = json.sessionId || null;
      }
      if (json.error) out.errors.push(json.error);
    }
    return out;
  }

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('mock agent: biryani search suggests real restaurants, agreement builds the plan', async () => {
    const sid = 'agent-test-biryani';
    const first = await postChatSSE({ message: 'find me biryani in hyderabad', city: 'hyderabad', sessionId: sid });
    assert.equal(first.errors.length, 0);
    assert.ok(first.done);
    assert.equal(first.sessionId, sid);
    assert.ok(first.text.includes('Paradise Biryani'), 'reply names a real restaurant');
    assert.equal(first.plans.length, 0, 'no plan change before agreement');

    const second = await postChatSSE({ message: 'yes, book it', city: 'hyderabad', sessionId: sid });
    assert.ok(second.done);
    assert.ok(second.plans.length > 0, 'agreement yields a plan event');
    const items = second.plans[second.plans.length - 1].items;
    assert.ok(items.some((i: any) => i.title === 'Paradise Biryani'), 'plan contains the agreed restaurant');
    for (const item of items) {
      assert.equal(item.type, 'restaurant');
      assert.ok(typeof item.startsAt === 'string', 'startsAt present');
      const t = Date.parse(item.startsAt);
      assert.ok(!isNaN(t), 'startsAt is valid ISO');
      assert.ok(t > Date.now(), 'startsAt is in the future');
    }
  });

  it('mock agent: server generates a sessionId when the client omits it', async () => {
    const out = await postChatSSE({ message: 'suggest a movie', city: 'hyderabad' });
    assert.ok(out.done);
    assert.ok(out.sessionId && out.sessionId.length > 8, 'server-issued sessionId');
    assert.ok(out.text.includes('RRR') || out.text.includes('Pushpa'), 'movie suggestions stream');
  });

  it('plan REST: GET returns items, DELETE removes one, POST clear empties', async () => {
    const sid = 'agent-test-rest';
    await postChatSSE({ message: 'any good events in hyderabad?', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes', city: 'hyderabad', sessionId: sid });

    const got: any = await (await fetch(`${base}/framebot/plans/${sid}`)).json();
    assert.equal(got.sessionId, sid);
    assert.ok(got.items.length > 0, 'plan has items after agreement');

    const firstId = got.items[0].id;
    const delRes = await fetch(`${base}/framebot/plans/${sid}/items/${firstId}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody: any = await delRes.json();
    assert.equal(delBody.items.length, got.items.length - 1);
    assert.ok(!delBody.items.some((i: any) => i.id === firstId));

    const badDel = await fetch(`${base}/framebot/plans/${sid}/items/nope`, { method: 'DELETE' });
    assert.equal(badDel.status, 404);

    const clearRes = await fetch(`${base}/framebot/plans/${sid}/clear`, { method: 'POST' });
    assert.equal(clearRes.status, 200);
    const clearBody: any = await clearRes.json();
    assert.deepEqual(clearBody.items, []);
  });
});
