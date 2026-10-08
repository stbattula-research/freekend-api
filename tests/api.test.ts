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
      suggestions: [] as any[][],
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
      if (json.suggestions) out.suggestions.push(json.suggestions);
      if (json.done) {
        out.done = true;
        out.sessionId = json.sessionId || null;
      }
      if (json.error) out.errors.push(json.error);
    }
    return out;
  }

  async function getPlanItems(sid: string): Promise<any[]> {
    const body: any = await (await fetch(`${base}/framebot/plans/${sid}`)).json();
    return body.items;
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

  it('mock agent: biryani search suggests real restaurants, user picks one', async () => {
    const sid = 'agent-test-biryani';
    const first = await postChatSSE({ message: 'find me biryani in hyderabad', city: 'hyderabad', sessionId: sid });
    assert.equal(first.errors.length, 0);
    assert.ok(first.done);
    assert.equal(first.sessionId, sid);
    assert.ok(first.text.includes('Paradise Biryani'), 'reply names a real restaurant');
    assert.equal(first.plans.length, 0, 'no plan change before a pick');
    assert.ok(first.suggestions.length > 0, 'suggestions emitted as pick cards');
    const cards = first.suggestions[first.suggestions.length - 1];
    assert.ok(cards.some((c: any) => c.title === 'Paradise Biryani'), 'cards include Paradise Biryani');

    // Bare "yes" with 2+ suggestions must NOT bulk-add — it asks which one.
    const second = await postChatSSE({ message: 'yes, book it', city: 'hyderabad', sessionId: sid });
    assert.ok(second.done);
    assert.equal(second.plans.length, 0, 'no plan change on ambiguous yes');
    assert.ok(/which one/i.test(second.text), 'reply asks which suggestion');

    // Explicit pick adds exactly one.
    const third = await postChatSSE({ message: 'yes, paradise biryani', city: 'hyderabad', sessionId: sid });
    assert.ok(third.done);
    assert.ok(third.plans.length > 0, 'pick yields a plan event');
    const items = third.plans[third.plans.length - 1].items;
    assert.equal(items.length, 1, 'exactly one item added');
    assert.equal(items[0].title, 'Paradise Biryani');
    assert.equal(items[0].type, 'restaurant');
    const t = Date.parse(items[0].startsAt);
    assert.ok(!isNaN(t) && t > Date.now(), 'startsAt is a valid future ISO');
  });

  it('mock agent: bare "yes" with 3 movie suggestions asks which, adds nothing', async () => {
    const sid = 'agent-test-pickone';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    const out = await postChatSSE({ message: 'yes', city: 'hyderabad', sessionId: sid });
    assert.ok(out.done);
    assert.equal(out.plans.length, 0, 'nothing added on ambiguous yes');
    assert.ok(/which one\?/i.test(out.text), 'reply asks which one');
    assert.ok(/1\) RRR/.test(out.text) && /2\)/.test(out.text), 'numbered list presented');
    const items = await getPlanItems(sid);
    assert.deepEqual(items, [], 'plan stays empty');
  });

  it('mock agent: "yes, RRR" adds exactly that movie', async () => {
    const sid = 'agent-test-pickrrr';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    const out = await postChatSSE({ message: 'yes, RRR', city: 'hyderabad', sessionId: sid });
    assert.ok(out.done);
    assert.ok(out.plans.length > 0);
    const items = out.plans[out.plans.length - 1].items;
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'RRR');
    assert.equal(items[0].type, 'movie');
  });

  it('mock agent: ordinal pick "the second one" adds that suggestion', async () => {
    const sid = 'agent-test-ordinal';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    const out = await postChatSSE({ message: 'the second one', city: 'hyderabad', sessionId: sid });
    const items = out.plans[out.plans.length - 1].items;
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Pushpa: The Rise');
  });

  it('mock agent: conflicting add proposes replace; "yes" swaps, double-booking impossible', async () => {
    const sid = 'agent-test-conflict';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes, RRR', city: 'hyderabad', sessionId: sid });
    let items = await getPlanItems(sid);
    assert.equal(items.length, 1);

    // "add Pushpa" clashes with RRR at 7:00 PM — must ask, not add.
    const clash = await postChatSSE({ message: 'add Pushpa', city: 'hyderabad', sessionId: sid });
    assert.ok(/already got RRR at 7:00 PM/i.test(clash.text), 'conflict question asked');
    assert.ok(/replace it with/i.test(clash.text));
    items = await getPlanItems(sid);
    assert.equal(items.length, 1, 'still one item after conflict');
    assert.equal(items[0].title, 'RRR');

    // Confirming performs the replace.
    const swapped = await postChatSSE({ message: 'yes', city: 'hyderabad', sessionId: sid });
    assert.ok(/swapped/i.test(swapped.text));
    items = await getPlanItems(sid);
    assert.equal(items.length, 1, 'still exactly one item — no double booking');
    assert.equal(items[0].title, 'Pushpa: The Rise');

    // Declining a replace keeps the plan intact.
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'add RRR', city: 'hyderabad', sessionId: sid });
    const declined = await postChatSSE({ message: 'no', city: 'hyderabad', sessionId: sid });
    assert.ok(/keeping your day as is/i.test(declined.text));
    items = await getPlanItems(sid);
    assert.equal(items[0].title, 'Pushpa: The Rise');
  });

  it('mock agent: "remove the movie" removes it conversationally', async () => {
    const sid = 'agent-test-remove';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes, RRR', city: 'hyderabad', sessionId: sid });
    assert.equal((await getPlanItems(sid)).length, 1);
    const out = await postChatSSE({ message: 'remove the movie', city: 'hyderabad', sessionId: sid });
    assert.ok(/removed/i.test(out.text));
    assert.deepEqual(await getPlanItems(sid), [], 'plan empty after remove');
  });

  it('mock agent: "change dinner to Bawarchi" swaps the restaurant, keeps the slot', async () => {
    const sid = 'agent-test-change';
    await postChatSSE({ message: 'find me biryani in hyderabad', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes, paradise biryani', city: 'hyderabad', sessionId: sid });
    const out = await postChatSSE({ message: 'change dinner to Bawarchi', city: 'hyderabad', sessionId: sid });
    assert.ok(/swapped/i.test(out.text), 'swap confirmed');
    const items = await getPlanItems(sid);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Bawarchi');
    assert.equal(items[0].time, '9:00 PM', 'original time slot kept');
  });

  it('mock agent: "move the movie to 8:30 pm" reschedules with valid future startsAt', async () => {
    const sid = 'agent-test-resched';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes, RRR', city: 'hyderabad', sessionId: sid });
    const out = await postChatSSE({ message: 'move the movie to 8:30 pm', city: 'hyderabad', sessionId: sid });
    assert.ok(/moved/i.test(out.text));
    const items = await getPlanItems(sid);
    assert.equal(items.length, 1);
    assert.equal(items[0].time, '8:30 PM');
    const t = Date.parse(items[0].startsAt);
    assert.ok(!isNaN(t) && t > Date.now(), 'startsAt recomputed to a future ISO');
  });

  it('mock agent: "clear my day" empties the plan', async () => {
    const sid = 'agent-test-clear';
    await postChatSSE({ message: 'suggest a movie', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'yes, RRR', city: 'hyderabad', sessionId: sid });
    assert.equal((await getPlanItems(sid)).length, 1);
    const out = await postChatSSE({ message: 'clear my day', city: 'hyderabad', sessionId: sid });
    assert.ok(/cleared/i.test(out.text));
    assert.deepEqual(await getPlanItems(sid), []);
  });

  it('mock agent: lat/lng sorts restaurants near-first with distances', async () => {
    const sid = 'agent-test-geo';
    const out = await postChatSSE({
      message: 'find me biryani',
      city: 'hyderabad',
      sessionId: sid,
      lat: 17.385,
      lng: 78.4867,
    });
    assert.ok(out.suggestions.length > 0, 'suggestion cards emitted');
    const cards = out.suggestions[out.suggestions.length - 1];
    assert.ok(cards.length > 0);
    const dists = cards.map((c: any) => {
      const m = /([\d.]+) km away/.exec(c.details || '');
      assert.ok(m, `details carry a distance: ${c.details}`);
      return parseFloat(m[1]);
    });
    const sorted = [...dists].sort((a, b) => a - b);
    assert.deepEqual(dists, sorted, 'cards sorted nearest-first');
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
    // Bare "yes" with several suggestions asks which — pick one explicitly.
    await postChatSSE({ message: 'yes', city: 'hyderabad', sessionId: sid });
    await postChatSSE({ message: 'the first one', city: 'hyderabad', sessionId: sid });

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
