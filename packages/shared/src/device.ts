export type DeviceType = 'mobile' | 'tablet' | 'desktop';
export type DeviceOs = 'ios' | 'android' | 'other';

export interface DeviceInfo {
  device: DeviceType;
  os: DeviceOs;
}

// Windows Phone se anuncia com "Android" e "iPhone" no UA; precisa vir antes.
const WINDOWS_PHONE = /Windows Phone|IEMobile/i;
const IOS = /iPhone|iPad|iPod/i;
const ANDROID = /Android/i;
const TABLET = /iPad|Tablet|Kindle|Silk\/|PlayBook|Nexus (7|9|10)\b|SM-T\d|Tab\b/i;
const MOBILE = /Mobi|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|webOS/i;

/**
 * Tipo de aparelho e sistema por regex no user agent (ADR 0002), sem biblioteca no caminho quente.
 * Android sem "Mobile" é tablet, pela convenção do próprio Android. O iPadOS 13+ se anuncia como
 * Macintosh e cai em desktop/other: não há como distinguir pelo UA.
 */
export function detectDevice(ua: string | undefined | null): DeviceInfo {
  const agent = ua ?? '';
  let os: DeviceOs = 'other';
  if (WINDOWS_PHONE.test(agent)) os = 'other';
  else if (IOS.test(agent)) os = 'ios';
  else if (ANDROID.test(agent)) os = 'android';

  let device: DeviceType = 'desktop';
  if (TABLET.test(agent) || (os === 'android' && !/Mobile/i.test(agent))) device = 'tablet';
  else if (MOBILE.test(agent)) device = 'mobile';
  return { device, os };
}
