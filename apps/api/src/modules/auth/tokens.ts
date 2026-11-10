import { jwtVerify, SignJWT } from 'jose';
import type { ApiConfig } from '../../config';

const ISSUER = 'encurtador';
const AUDIENCE = 'encurtador-api';

/** Access token HS256 de 15 min (ADR 0004): só `sub`, sem dados pessoais. */
export class AccessTokens {
  private readonly key: Uint8Array;
  constructor(private readonly config: ApiConfig) {
    this.key = new TextEncoder().encode(config.jwtSecret);
  }

  sign(userId: number): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(String(userId))
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.accessTtlSeconds}s`)
      .sign(this.key);
  }

  /** Id do usuário, ou `null` para assinatura, emissor, audiência ou validade errados. */
  async verify(token: string): Promise<number | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const id = Number(payload.sub);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }
}
