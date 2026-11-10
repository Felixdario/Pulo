import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { UA_HUMANO } from './ambiente';

/** Entra no demo pela página de login (o mesmo botão da landing). */
export async function entrarNoDemo(page: Page, destino = '/app') {
  await page.goto(`/entrar?redirect=${encodeURIComponent(destino)}`);
  await page.getByRole('button', { name: 'Entrar no demo' }).click();
  await expect(page).toHaveURL(new RegExp(`${destino.replace(/\//g, '\\/')}$`));
}

/** Um clique de gente no redirect, sem seguir o 302. */
export async function clicar(request: APIRequestContext, shortUrl: string) {
  const res = await request.get(shortUrl, {
    maxRedirects: 0,
    headers: { 'user-agent': UA_HUMANO },
  });
  expect(res.status()).toBe(302);
  return res;
}

export const sufixo = () => Math.random().toString(36).slice(2, 8);
