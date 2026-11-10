import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createKey, createLink, expectProblem, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

interface SseClient {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => string;
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
  close: () => void;
}

function openSse(port: number, path: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (buf += c));
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buf,
        waitFor: async (re, ms = 3000) => {
          const start = Date.now();
          while (!re.test(buf)) {
            if (Date.now() - start > ms) throw new Error(`não chegou ${re}: ${buf}`);
            await new Promise((r) => setTimeout(r, 20));
          }
          return buf;
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

async function listening(overrides = {}) {
  const app = await t.app(overrides);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, port: (app.server.address() as AddressInfo).port };
}

describe('SSE ao vivo', () => {
  it('recebe o evento publicado em live:<user_id>, filtrado pelo link, com heartbeat', async () => {
    const { app, port } = await listening({ liveHeartbeatMs: 100 });
    const s = await signup(app);
    const l1 = await createLink(app, s);
    const l2 = await createLink(app, s);
    const tk = await app.inject({ method: 'POST', url: '/v1/live/ticket', headers: s.auth });
    expect(tk.statusCode).toBe(200);
    const { ticket, expires_in } = tk.json();
    expect(expires_in).toBe(30);
    expect(await t.redis.ttl(`lt:${ticket}`)).toBeGreaterThan(0);

    const sse = await openSse(port, `/v1/live?ticket=${ticket}&link_id=${l1.id}`);
    expect(sse.status).toBe(200);
    expect(sse.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(sse.headers['ratelimit-limit']).toBeDefined();
    await sse.waitFor(/event: ready/);
    // Mesmo formato do worker (ADR 0003).
    await t.redis.publish(
      `live:${s.userId}`,
      JSON.stringify({ link_id: l2.id, humans: 9, total: 9 }),
    );
    await t.redis.publish(
      `live:${s.userId}`,
      JSON.stringify({ link_id: l1.id, humans: 1, total: 2 }),
    );
    await t.redis.publish(
      `live:${s.userId + 999}`,
      JSON.stringify({ link_id: l1.id, humans: 5, total: 5 }),
    );
    const text = await sse.waitFor(/event: click\ndata: \{"link_id":\d+,"humans":1,"total":2\}/);
    expect(text).not.toContain('"humans":9');
    expect(text).not.toContain('"humans":5');
    await sse.waitFor(/: heartbeat/);
    // O ticket foi consumido.
    expect(await t.redis.exists(`lt:${ticket}`)).toBe(0);
    sse.close();
  });

  it('ticket de uso único, inexistente ou ausente; ticket exige stats:read', async () => {
    const { app } = await listening();
    const s = await signup(app);
    const { ticket } = (
      await app.inject({ method: 'POST', url: '/v1/live/ticket', headers: s.auth })
    ).json();
    await t.redis.getdel(`lt:${ticket}`);
    expectProblem(
      await app.inject({ method: 'GET', url: `/v1/live?ticket=${ticket}` }),
      401,
      'invalid_ticket',
    );
    expectProblem(await app.inject({ method: 'GET', url: '/v1/live' }), 422, 'validation');
    expectProblem(await app.inject({ method: 'POST', url: '/v1/live/ticket' }), 401);
    const k = await createKey(app, s, ['links:read']);
    expectProblem(
      await app.inject({ method: 'POST', url: '/v1/live/ticket', headers: { 'x-api-key': k.key } }),
      403,
      'insufficient_scope',
    );
  });

  it('fecha quando o cliente desconecta e desassina o canal', async () => {
    const { app, port } = await listening();
    const s = await signup(app);
    const open = async () => {
      const { ticket } = (
        await app.inject({ method: 'POST', url: '/v1/live/ticket', headers: s.auth })
      ).json();
      const c = await openSse(port, `/v1/live?ticket=${ticket}`);
      await c.waitFor(/event: ready/);
      return c;
    };
    const a = await open();
    const b = await open();
    const subs = async () =>
      ((await t.redis.call('PUBSUB', 'NUMSUB', `live:${s.userId}`)) as [string, number])[1];
    expect(await subs()).toBe(1);
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(await subs()).toBe(1);
    b.close();
    await expect.poll(subs, { timeout: 3000 }).toBe(0);
  });
});
