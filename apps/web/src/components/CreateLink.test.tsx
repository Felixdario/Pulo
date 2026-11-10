import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/session';
import { CreateLink } from './CreateLink';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreateLink />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

describe('CreateLink: alias com validação ao vivo', () => {
  it('mostra o erro de formato e de reservado enquanto digita, e "válido" quando passa', async () => {
    const { user } = setup();
    const alias = screen.getByLabelText('Alias (opcional)');
    expect(screen.getByText(/sai um nome aleatório/)).toBeInTheDocument();

    await user.type(alias, 'ad');
    expect(screen.getByText('Use pelo menos 3 caracteres.')).toBeInTheDocument();
    expect(alias).toHaveAttribute('aria-invalid', 'true');

    await user.type(alias, 'min');
    expect(
      screen.getByText('"admin" é um nome reservado pelo sistema. Escolha outro.'),
    ).toBeInTheDocument();

    await user.clear(alias);
    await user.type(alias, 'black friday');
    expect(
      screen.getByText('Só letras sem acento, números, _ e -. Tire espaço.'),
    ).toBeInTheDocument();

    await user.clear(alias);
    await user.type(alias, 'black-friday');
    expect(screen.getByText('Formato válido.')).toBeInTheDocument();
    expect(alias).not.toHaveAttribute('aria-invalid');
  });

  it('não envia com alias inválido e manda Idempotency-Key nova a cada tentativa', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('rede'));
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}));
    const { user } = setup();
    await user.type(screen.getByLabelText('Link para encurtar'), 'loja.com.br/natal');
    await user.type(screen.getByLabelText('Alias (opcional)'), 'api');
    await user.click(screen.getByRole('button', { name: 'Encurtar' }));
    expect(post).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Alias (opcional)'));
    await user.click(screen.getByRole('button', { name: 'Encurtar' }));
    await user.click(await screen.findByRole('button', { name: 'Encurtar' }));
    expect(post).toHaveBeenCalledTimes(2);
    const [path, body, opts] = post.mock.calls[0]!;
    expect(path).toBe('/v1/links');
    expect(body).toEqual({ destination: 'https://loja.com.br/natal' });
    const k1 = (opts as { headers: Record<string, string> }).headers['idempotency-key'];
    const k2 = (post.mock.calls[1]![2] as { headers: Record<string, string> }).headers[
      'idempotency-key'
    ];
    expect(k1).toBeTruthy();
    expect(k1).not.toBe(k2);
  });

  it('erro de destino em rede privada aparece no campo, em pt-BR', async () => {
    const { ApiError } = await import('../lib/api/problem');
    vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiError(422, {
        status: 422,
        code: 'validation',
        errors: [
          { field: 'destination', code: 'private_host', message: 'destino em rede privada' },
        ],
      }),
    );
    const { user } = setup();
    await user.type(screen.getByLabelText('Link para encurtar'), '192.168.0.10/painel');
    await user.click(screen.getByRole('button', { name: 'Encurtar' }));
    expect(await screen.findByText(/rede privada ou local/)).toBeInTheDocument();
    expect(screen.getByLabelText('Link para encurtar')).toHaveAttribute('aria-invalid', 'true');
  });
});
