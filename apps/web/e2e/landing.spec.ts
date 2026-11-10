import { expect, test } from '@playwright/test';
import { SHORT_BASE_URL } from './ambiente';
import { clicar } from './apoio';

test('landing encurta sem login e o redirect leva ao destino', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /Encurte links\.\s*Conte só gente\./i,
  );

  // Erro claro antes de ir à rede.
  await page.getByLabel('Link para encurtar').fill('isso não é um link');
  await page.getByRole('button', { name: 'Encurtar' }).click();
  await expect(page.getByRole('alert')).toContainText('Isso não parece um endereço da web');

  // Rede privada: a frase vem do problem+json da API.
  await page.getByLabel('Link para encurtar').fill('http://192.168.0.10/painel');
  await page.getByRole('button', { name: 'Encurtar' }).click();
  await expect(page.getByRole('alert')).toContainText('rede privada ou local');

  // Sem https://: completa sozinho.
  await page.getByLabel('Link para encurtar').fill('example.com/artigo-do-e2e');
  await page.getByRole('button', { name: 'Encurtar' }).click();
  const tira = page.locator('.tira-resultado');
  await expect(tira.getByText('Seu link curto')).toBeVisible();
  await expect(tira.getByRole('button', { name: 'Copiar' })).toBeVisible();
  await expect(tira.getByRole('img', { name: /QR code/ })).toBeVisible();
  await expect(tira).toContainText('Vale até');

  const texto = (await tira.locator('.tira-curto [aria-hidden="true"]').innerText()).trim();
  const host = new URL(SHORT_BASE_URL).host;
  expect(texto.startsWith(`${host}/`)).toBe(true);
  const res = await clicar(request, `http://${texto}`);
  expect(res.headers().location).toBe('https://example.com/artigo-do-e2e');
});
