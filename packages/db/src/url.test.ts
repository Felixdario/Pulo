import { describe, expect, it } from 'vitest';
import { normalizeDatabaseUrl } from './url';

describe('normalizeDatabaseUrl', () => {
  it('tira channel_binding da URL do Neon e mantém o sslmode', () => {
    const url = normalizeDatabaseUrl(
      'postgresql://u:s@ep-x.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    );
    expect(url).toBe('postgresql://u:s@ep-x.us-east-1.aws.neon.tech/neondb?sslmode=require');
  });

  it('não mexe numa URL sem channel_binding', () => {
    const local = 'postgres://encurtador:encurtador@localhost:5433/encurtador';
    expect(normalizeDatabaseUrl(local)).toBe(local);
  });
});
