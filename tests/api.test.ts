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
