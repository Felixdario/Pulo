import { expect, test } from '@playwright/test';
import { entrarNoDemo, sufixo } from './apoio';

test('cria uma chave (aparece uma vez) e revoga', async ({ page }) => {
  await entrarNoDemo(page, '/app/keys');
  const nome = `CI e2e ${sufixo()}`;
  await page.getByLabel('Nome').fill(nome);
  await page.getByLabel(/stats:read/).check();
  await page.getByRole('button', { name: 'Criar chave' }).click();

  await expect(page.getByText('Guarde agora: depois ela não aparece mais.')).toBeVisible();
  const segredo = await page.getByTestId('chave-nova').innerText();
  expect(segredo).toMatch(/^enc_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
  await expect(page.getByRole('button', { name: 'Copiar' })).toBeVisible();
  await page.getByRole('button', { name: 'Já guardei' }).click();
  await expect(page.getByText(segredo)).toHaveCount(0);

  const linha = page.locator('tbody tr', { hasText: nome });
  await expect(linha).toContainText(`enc_${segredo.slice(4, 12)}_…`);
  await expect(linha).toContainText('links:read');
  await expect(linha).toContainText('stats:read');
  await expect(linha).toContainText('Nunca usada');

  await linha.getByRole('button', { name: `Revogar ${nome}` }).click();
  const confirmar = page.getByRole('alertdialog');
  await expect(confirmar).toContainText(`Revogar ${nome}?`);
  await confirmar.getByRole('button', { name: 'Revogar chave' }).click();
  await expect(linha).toHaveCount(0);
});
