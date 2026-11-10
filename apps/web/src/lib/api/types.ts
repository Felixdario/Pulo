/** Tipos das respostas da API `/v1` (espelham os schemas Zod de `apps/api`, ver `/docs/json`). */

export interface User {
  id: number;
  email: string;
  created_at: string;
}

export interface Session {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: User;
}

export type RedirectType = 301 | 302 | 307 | 308;
export type DeviceMatch = 'ios' | 'android' | 'mobile' | 'tablet' | 'desktop';

export interface GeoRule {
  countries: string[];
  url: string;
}
export interface DeviceRule {
  match: DeviceMatch;
  url: string;
}
export interface LinkRules {
  geo?: GeoRule[];
  device?: DeviceRule[];
}

export interface Link {
  id: number;
  slug: string;
  short_url: string;
  is_custom: boolean;
  destination: string;
  title: string | null;
  redirect_type: number;
  cache_ttl: number;
  status: 'active' | 'disabled' | 'blocked_loop';
  is_expired: boolean;
  expires_at: string | null;
  max_clicks: number | null;
  has_password: boolean;
  forward_query: boolean;
  rules: LinkRules;
  created_at: string;
  updated_at: string;
}

export interface LinkListItem extends Link {
  click_count: number;
}

export interface LinkPage {
  data: LinkListItem[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface LinkCreate {
  destination: string;
  alias?: string;
  title?: string | null;
}

export interface LinkPatch {
  destination?: string;
  title?: string | null;
  redirect_type?: RedirectType;
  expires_at?: string | null;
  max_clicks?: number | null;
  password?: string | null;
  forward_query?: boolean;
  rules?: LinkRules;
  status?: 'active' | 'disabled';
}

export interface PublicLink {
  slug: string;
  short_url: string;
  destination: string;
  expires_at: string;
}

export interface Preview {
  url: string;
  final_url: string;
  redirects: number;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
  site_name: string | null;
}

export interface SeriesPoint {
  start: string;
  label: string;
  total: number;
  humans: number;
  uniques: number | null;
  bots: number;
  previews: number;
}

export interface Timeseries {
  link_id: number;
  granularity: 'hour' | 'day' | 'month';
  tz: string;
  from: string;
  to: string;
  uniques_available: boolean;
  totals: Omit<SeriesPoint, 'start' | 'label'>;
  points: SeriesPoint[];
}

export interface Summary {
  link_id: number;
  from: string;
  to: string;
  total: number;
  humans: number;
  uniques: number;
  unique_ratio: number | null;
  bots: number;
  previews: number;
  preview_apps: { app: string; n: number }[];
  all_time_humans: number;
}

export interface TopDimension {
  link_id: number;
  dimension: string;
  from: string;
  to: string;
  total: number;
  items: { value: string; n: number; share: number }[];
  others: number;
}

export type ApiScope = 'links:read' | 'links:write' | 'stats:read';

export interface ApiKey {
  id: number;
  name: string;
  display: string;
  prefix: string;
  scopes: ApiScope[];
  last_used_at: string | null;
  created_at: string;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

export interface LiveClick {
  link_id: number;
  humans: number;
  total: number;
}
