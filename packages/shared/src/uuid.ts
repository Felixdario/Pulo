const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * UUIDv7 (RFC 9562): 48 bits de epoch em ms, versão 7, 74 bits aleatórios. Ordenável por tempo,
 * usado como `event_id` dos cliques.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  let ms = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => HEX[x]!);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h
    .slice(8, 10)
    .join('')}-${h.slice(10).join('')}`;
}

const UUIDV7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Os 48 bits de tempo (epoch ms) de um UUIDv7, ou null se não for um UUIDv7 válido (versão 7,
 * variante RFC). O worker usa isso como `occurred_at`: o instante fica preso ao `event_id`, então
 * uma reentrega com outro `ts` cai na mesma chave e é deduplicada.
 */
export function uuidv7Timestamp(id: string): number | null {
  const m = UUIDV7.exec(id);
  if (!m) return null;
  return parseInt(m[1]! + m[2]!, 16);
}
