import { describe, expect, it } from 'vitest';
import { createDb } from './client';

describe('createDb', () => {
  it('exige DATABASE_URL', () => {
    expect(() => createDb('')).toThrow(/DATABASE_URL/);
  });

  it('cria o cliente sem conectar', async () => {
    const { db, close } = createDb('postgres://u:p@localhost:1/x');
    expect(db).toBeDefined();
    await close();
  });
});
