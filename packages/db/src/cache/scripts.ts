import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface LuaScript {
  lua: string;
  sha: string;
}

const script = (lua: string): LuaScript => ({
  lua,
  sha: createHash('sha1').update(lua).digest('hex'),
});

/**
 * Executa com EVALSHA; se o Redis não conhece o script (NOSCRIPT: reinício, SCRIPT FLUSH, failover),
 * manda o corpo com EVAL, que também o deixa em cache para a próxima.
 */
export async function runScript(
  redis: Redis,
  s: LuaScript,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  try {
    return await redis.evalsha(s.sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
      return redis.eval(s.lua, keys.length, ...keys, ...args);
    }
    throw err;
  }
}

/**
 * Token bucket (ADR 0002, seção 4) + GET do link na mesma ida ao Redis.
 *
 * KEYS[1] = balde do visitante; KEYS[2] (opcional) = `l:<slug>`.
 * ARGV = capacidade, reposição por segundo, agora em ms ("" = TIME do Redis, o padrão: todas as
 * instâncias usam o mesmo relógio), custo.
 * Devolve {permitido, restantes, retry_ms, reset_ms, valor_do_link|nil}. O GET só roda se permitido.
 *
 * As duas chaves ficam em slots diferentes: em Redis Cluster seria preciso uma hash tag comum.
 */
export const BUCKET_GET = script(`
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[4]) or 1
local now
if ARGV[3] ~= nil and ARGV[3] ~= '' then
  now = tonumber(ARGV[3])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local b = redis.call('HMGET', KEYS[1], 'tk', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil or ts == nil then
  tokens = cap
  ts = now
end
if now > ts then
  tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
  ts = now
end
local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tk', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], math.ceil(cap * 1000 / rate) + 1000)
local retry = 0
if allowed == 0 then retry = math.ceil((cost - tokens) * 1000 / rate) end
local reset = math.ceil((cap - tokens) * 1000 / rate)
local link = false
if allowed == 1 and #KEYS > 1 then link = redis.call('GET', KEYS[2]) end
return {allowed, math.floor(tokens), retry, reset, link}
`);

/**
 * Limite de cliques: KEYS[1] = `cap:<id>`; ARGV = modo ("incr" | "peek"), valor inicial ("" = não
 * inicializar), TTL em segundos. Sem a chave e sem valor inicial devolve nil: quem chama busca o total
 * no banco e chama de novo com ele (SET NX, então duas instâncias não se atropelam).
 */
export const CLICK_CAP = script(`
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[1], ARGV[2], 'NX', 'EX', ARGV[3])
end
local cur = redis.call('GET', KEYS[1])
if not cur then return false end
if ARGV[1] == 'peek' then return tonumber(cur) end
local v = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return v
`);
