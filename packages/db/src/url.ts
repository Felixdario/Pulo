/**
 * Ajusta a URL do banco como os provedores a entregam (Neon: `...?sslmode=require&channel_binding=require`).
 *
 * O postgres.js manda ao servidor, como parâmetro de sessão, todo parâmetro da URL que ele não
 * conhece; `channel_binding` não é um parâmetro do PostgreSQL e derrubaria a conexão. O SSL
 * continua pedido pelo `sslmode`.
 */
export function normalizeDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('channel_binding');
  return parsed.toString();
}
