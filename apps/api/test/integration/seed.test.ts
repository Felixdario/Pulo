import { links, sql } from '@encurtador/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from '../../src/seed/demo';
import { createLink, setup, signup } from './helpers';

const t = setup();
beforeEach(() => t.reset());
afterAll(() => t.teardown());

const one = async <T>(q: ReturnType<typeof sql>) => ((await t.db.execute(q)) as unknown as T[])[0]!;

describe('seed demo', () => {
  it('idempotente, coerente entre os agregados e sem tocar em outro usuário', async () => {
    const app = await t.app();
    const other = await signup(app);
    const keep = await createLink(app, other, { alias: 'de-outro' });
    await t.db.execute(sql`
      INSERT INTO clicks_daily (link_id, day, total, humans, uniques, bots, previews)
      VALUES (${keep.id}, current_date, 5, 5, 5, 0, 0)`);

    const first = await seedDemo(t.db);
    expect(first.links).toBe(30);
    expect(first.key).toMatch(/^enc_/);
    const second = await seedDemo(t.db);
    expect(second).toMatchObject({
      userId: first.userId,
      links: 30,
      humans: first.humans,
      key: null,
    });

    const c = await one<Record<string, string>>(sql`
      SELECT
        (SELECT count(*) FROM links WHERE user_id = ${first.userId}) AS links,
        (SELECT count(*) FROM api_keys WHERE user_id = ${first.userId}) AS keys,
        (SELECT count(*) FROM users WHERE email = ${DEMO_EMAIL}) AS users,
        (SELECT sum(humans) FROM clicks_hourly h JOIN links l ON l.id = h.link_id WHERE l.user_id = ${first.userId}) AS hourly,
        (SELECT sum(humans) FROM clicks_daily d JOIN links l ON l.id = d.link_id WHERE l.user_id = ${first.userId}) AS daily,
        (SELECT sum(click_count) FROM links WHERE user_id = ${first.userId}) AS counted,
        (SELECT count(*) FROM (
           SELECT 1 FROM clicks_daily d JOIN clicks_daily_dim x USING (link_id, day)
           JOIN links l ON l.id = d.link_id WHERE l.user_id = ${first.userId}
           GROUP BY d.link_id, d.day, x.dim, d.humans HAVING sum(x.n) <> d.humans) z) AS dim_bad,
        (SELECT count(*) FROM clicks_daily WHERE link_id = ${keep.id}) AS other_rows,
        (SELECT max(length(destination)) FROM links WHERE user_id = ${first.userId}) AS longest`);
    expect(c).toMatchObject({ links: '30', keys: '1', users: '1', dim_bad: '0', other_rows: '1' });
    expect(Number(c.longest)).toBe(2000);
    expect(Number(c.hourly)).toBe(first.humans);
    expect(Number(c.daily)).toBe(first.humans);
    expect(Number(c.counted)).toBe(first.humans);
    expect(first.humans).toBeGreaterThan(1000);

    // O demo entra com a senha do ADR e vê os 30 links.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/links?limit=100',
      headers: { authorization: `Bearer ${login.json().access_token}` },
    });
    expect(list.json().data).toHaveLength(30);
    const all = await t.db.select({ id: links.id }).from(links);
    expect(all).toHaveLength(31);
  });
});
