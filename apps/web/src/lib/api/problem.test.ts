import { describe, expect, it } from 'vitest';
import { ApiError, fieldMessage, formatWait } from './problem';

const p = (
  status: number,
  code: string,
  errors?: { field: string; code: string; message: string }[],
) => ({
  type: `https://encurta.dev/problems/${code}`,
  title: 'título técnico',
  status,
  code,
  detail: 'detalhe técnico em minúsculas',
  ...(errors ? { errors } : {}),
});

describe('problem+json → pt-BR', () => {
  it('destino em rede privada, loop e URL inválida têm frase própria', () => {
    const priv = new ApiError(
      422,
      p(422, 'validation', [
        { field: 'destination', code: 'private_host', message: 'destino em rede privada ou local' },
      ]),
    );
    expect(priv.fields.destination).toMatch(/rede privada ou local/);
    expect(priv.firstMessage).toBe(priv.fields.destination);

    const loop = new ApiError(
      422,
      p(422, 'validation', [{ field: 'destination', code: 'loop', message: 'x' }]),
    );
    expect(loop.fields.destination).toBe(
      'Esse endereço já é um link curto nosso. Apontar para ele criaria um loop.',
    );

    const bad = new ApiError(
      422,
      p(422, 'validation', [{ field: 'destination', code: 'invalid_url', message: 'x' }]),
    );
    expect(bad.fields.destination).toContain('Isso não parece um endereço da web');
  });

  it('nunca mostra o detail técnico da API', () => {
    const e = new ApiError(409, p(409, 'alias_taken'));
    expect(e.message).toBe('Este alias já está em uso. Escolha outro.');
    expect(e.message).not.toContain('técnico');
  });

  it('412 fala da outra aba', () => {
    expect(new ApiError(412, p(412, 'precondition_failed')).message).toBe(
      'Alguém editou este link em outra aba. Recarregue para ver a versão atual.',
    );
  });

  it('campos de regra e erros genéricos do Zod caem num texto útil', () => {
    expect(fieldMessage({ field: 'rules.geo.0.url', code: 'private_host', message: '' })).toMatch(
      /rede privada/,
    );
    expect(fieldMessage({ field: 'rules.device.1.url', code: 'too_small', message: '' })).toBe(
      'Confira o endereço desta regra.',
    );
    expect(fieldMessage({ field: 'email', code: 'invalid_format', message: '' })).toContain(
      'e-mail válido',
    );
    expect(fieldMessage({ field: 'qualquer', code: 'x', message: '' })).toBe('Confira este campo.');
  });

  it('status sem corpo e 5xx têm mensagem', () => {
    expect(new ApiError(503, null).message).toBe(
      'Algo deu errado do nosso lado. Tente de novo em instantes.',
    );
    expect(new ApiError(418, null).message).toBe('Não deu certo. Tente de novo.');
  });

  it('formata a espera do 429', () => {
    expect(formatWait(40)).toBe('40 s');
    expect(formatWait(61)).toBe('2 min');
    expect(formatWait(60)).toBe('1 min');
  });
});
