import { describe, expect, it } from 'vitest';
import type { Link } from './api/types';
import { ruleChips } from './rules';

describe('ruleChips (break-ui)', () => {
  it('a frase do aparelho mantém iPhone e Android com a caixa certa', () => {
    const link = {
      status: 'active',
      expires_at: null,
      is_expired: false,
      has_password: false,
      max_clicks: null,
      click_count: 0,
      redirect_type: 302,
      forward_query: false,
      rules: {
        device: [
          { match: 'ios', url: 'https://apps.apple.com/app' },
          { match: 'android', url: 'https://play.google.com/app' },
          { match: 'tablet', url: 'https://loja.example.com/tablet' },
        ],
      },
    } as unknown as Link;
    const frases = ruleChips(link).map((c) => c.sentence);
    expect(frases).toContain('No iPhone e iPad, vai para apps.apple.com.');
    expect(frases).toContain('No Android, vai para play.google.com.');
    expect(frases).toContain('No tablet, vai para loja.example.com.');
  });
});
