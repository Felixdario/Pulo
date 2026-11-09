import { isbot } from 'isbot';

export type AgentKind = 'human' | 'bot' | 'preview';

/**
 * Buscadores de prévia de link (ADR 0003). Vêm antes do `isbot`, que também os marcaria como bot:
 * a prévia é contada à parte, não some junto com os robôs.
 */
const PREVIEW =
  /WhatsApp|Slackbot-LinkExpanding|Slack-ImgProxy|facebookexternalhit|Facebot|Twitterbot|TelegramBot|Discordbot|LinkedInBot|SkypeUriPreview|Applebot|redditbot|Embedly|Iframely/i;

/**
 * Classificação rápida, usada pelo redirect (para não gastar limite de cliques com prévia ou robô)
 * e pelo worker. `HEAD` sem user agent é robô; `GET` sem user agent é humano (navegadores sempre
 * mandam, mas o ADR só exclui o `HEAD`).
 */
export function classifyAgent(ua: string | undefined | null, method = 'GET'): AgentKind {
  const agent = ua?.trim() ?? '';
  if (agent === '') return method.toUpperCase() === 'HEAD' ? 'bot' : 'human';
  if (PREVIEW.test(agent)) return 'preview';
  if (isbot(agent)) return 'bot';
  return 'human';
}
