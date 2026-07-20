import { isAllowedOrigin } from './cors';
import { getClientIp } from './middleware';
import type { Env } from './types';

type Channel = 'direct' | 'internal' | 'search' | 'referral' | 'social';

export interface AnalyticsViewBody {
  pageId?: string;
  pageTitle?: string;
  pageUrl?: string;
  canonicalUrl?: string;
  referrer?: string;
  referrerDomain?: string;
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
  };
  channel?: string;
  screen?: {
    width?: number;
    height?: number;
  };
  viewport?: {
    width?: number;
    height?: number;
  };
  deviceType?: string;
  language?: string;
  timezone?: string;
  visitorId?: string;
  sessionId?: string;
}

export interface PageStats {
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  canonicalUrl: string;
  views: number;
  visitors: number;
  sessions: number;
  searchViews: number;
  messageCount: number;
}

const CHANNEL_COLUMNS: Record<Channel, string> = {
  direct: 'direct_views',
  internal: 'internal_views',
  search: 'search_views',
  referral: 'referral_views',
  social: 'social_views',
};

const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_EVENTS_PER_IP_PER_WINDOW = 60;
const MAX_EVENTS_PER_ORIGIN_PER_WINDOW = 600;
const DUPLICATE_WINDOW_SECONDS = 30;
const ID_PATTERN = /^[a-z]_[A-Za-z0-9_-]{8,80}$/;

export class AnalyticsRequestError extends Error {
  constructor(message: string, public status: number, public code: 'forbidden' | 'rate_limited' | 'invalid') {
    super(message);
    this.name = 'AnalyticsRequestError';
  }
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function int(value: unknown, min = 0, max = 100000): number {
  const n = typeof value === 'number' ? Math.floor(value) : 0;
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : 0;
}

function normalizeChannel(value: unknown): Channel {
  return value === 'internal' || value === 'search' || value === 'referral' || value === 'social'
    ? value
    : 'direct';
}

function validateTrackingId(value: string, prefix: 'v' | 's', fieldName: string): void {
  if (!ID_PATTERN.test(value) || !value.startsWith(`${prefix}_`)) {
    throw new AnalyticsRequestError(`${fieldName} is invalid`, 400, 'invalid');
  }
}

function validatePageId(pageId: string): void {
  if (pageId.length > 500 || !pageId.startsWith('/') || pageId.startsWith('//')) {
    throw new AnalyticsRequestError('pageId is invalid', 400, 'invalid');
  }
  if (/[\u0000-\u001f\u007f\\#]/.test(pageId) || pageId.includes('..')) {
    throw new AnalyticsRequestError('pageId is invalid', 400, 'invalid');
  }
}

function sameOriginUrl(value: unknown, origin: string, fieldName: string): string {
  const raw = text(value, 1000);
  if (!raw) return '';
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) {
      throw new Error('origin mismatch');
    }
    return url.toString();
  } catch {
    throw new AnalyticsRequestError(`${fieldName} origin is not allowed`, 403, 'forbidden');
  }
}

async function enforceAnalyticsRateLimit(env: Env, clientIp: string, origin: string): Promise<void> {
  const windowModifier = `-${RATE_LIMIT_WINDOW_SECONDS} seconds`;
  const [ipCount, originCount] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM analytics_events
       WHERE created_at >= datetime('now', ?) AND ip_address = ?`
    ).bind(windowModifier, clientIp).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM analytics_events
       WHERE created_at >= datetime('now', ?) AND page_url LIKE ?`
    ).bind(windowModifier, `${origin}%`).first<{ count: number }>(),
  ]);

  if ((ipCount?.count || 0) >= MAX_EVENTS_PER_IP_PER_WINDOW) {
    throw new AnalyticsRequestError('Too many analytics events from this IP', 429, 'rate_limited');
  }
  if ((originCount?.count || 0) >= MAX_EVENTS_PER_ORIGIN_PER_WINDOW) {
    throw new AnalyticsRequestError('Too many analytics events from this origin', 429, 'rate_limited');
  }
}

/** 获取中国时区（UTC+8）的今日日期 */
function today(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

function dateFromCreatedAt(createdAt: string | null | undefined): string {
  return createdAt ? createdAt.slice(0, 10) : today();
}

/** 内存缓存：analytics_enabled 配置（60s TTL，避免每次 PV 查询 D1） */
let analyticsEnabledCache: { value: boolean; expiresAt: number } | null = null;
const ANALYTICS_CACHE_TTL = 60_000;

export async function isAnalyticsEnabled(env: Env): Promise<boolean> {
  const now = Date.now();
  if (analyticsEnabledCache && now < analyticsEnabledCache.expiresAt) {
    return analyticsEnabledCache.value;
  }
  const config = await env.DB.prepare(
    'SELECT analytics_enabled FROM board_config WHERE id = 1'
  ).first<{ analytics_enabled: number }>();
  const value = config?.analytics_enabled !== 0;
  analyticsEnabledCache = { value, expiresAt: now + ANALYTICS_CACHE_TTL };
  return value;
}

/**
 * 获取页面统计数据（直接读取缓存字段，不再实时 COUNT 留言数）
 * message_count 由 adjustMessageCount() 在留言增删时维护
 */
export async function getPageStats(env: Env, pageId: string): Promise<PageStats> {
  const row = await env.DB.prepare(
    `SELECT page_id, page_title, page_url, canonical_url, views, visitors, sessions, search_views, message_count
     FROM analytics_page_totals
     WHERE page_id = ?`
  ).bind(pageId).first<{
    page_id: string;
    page_title: string;
    page_url: string;
    canonical_url: string;
    views: number;
    visitors: number;
    sessions: number;
    search_views: number;
    message_count: number;
  }>();

  if (row) {
    return {
      pageId: row.page_id,
      pageTitle: row.page_title || '',
      pageUrl: row.page_url || '',
      canonicalUrl: row.canonical_url || '',
      views: row.views || 0,
      visitors: row.visitors || 0,
      sessions: row.sessions || 0,
      searchViews: row.search_views || 0,
      messageCount: row.message_count || 0,
    };
  }

  return {
    pageId,
    pageTitle: '',
    pageUrl: '',
    canonicalUrl: '',
    views: 0,
    visitors: 0,
    sessions: 0,
    searchViews: 0,
    messageCount: 0,
  };
}

async function getApprovedMessageCount(env: Env, pageId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM messages WHERE page_id = ? AND status = 'approved'`
  ).bind(pageId).first<{ count: number }>();
  return row?.count || 0;
}

/**
 * 记录页面访问事件（拆为同步判断 + 异步写入两阶段）
 * - 同步阶段：去重检查 + 读取当前统计 + 构建乐观返回值
 * - 异步阶段：D1 Batch 写入（由调用方通过 ctx.waitUntil() 异步执行）
 */
export async function recordPageView(
  env: Env, request: Request, body: AnalyticsViewBody
): Promise<{ stats: PageStats; writePromise: Promise<void> }> {
  const origin = request.headers.get('Origin') || '';
  if (!isAllowedOrigin(origin, env)) {
    throw new AnalyticsRequestError('Analytics origin is not allowed', 403, 'forbidden');
  }

  const pageId = text(body.pageId, 500);
  const visitorId = text(body.visitorId, 128);
  const sessionId = text(body.sessionId, 128);

  if (!pageId || !visitorId || !sessionId) {
    throw new AnalyticsRequestError('pageId, visitorId and sessionId are required', 400, 'invalid');
  }
  validatePageId(pageId);
  validateTrackingId(visitorId, 'v', 'visitorId');
  validateTrackingId(sessionId, 's', 'sessionId');

  const clientIp = getClientIp(request);
  const pageUrl = sameOriginUrl(body.pageUrl, origin, 'pageUrl');
  if (!pageUrl) {
    throw new AnalyticsRequestError('pageUrl is required', 400, 'invalid');
  }
  const canonicalUrl = sameOriginUrl(body.canonicalUrl, origin, 'canonicalUrl');

  if (!(await isAnalyticsEnabled(env))) {
    const stats = await getPageStats(env, pageId);
    return { stats, writePromise: Promise.resolve() };
  }

  await enforceAnalyticsRateLimit(env, clientIp, origin);

  // 阶段1：去重检查（需同步等结果）
  const duplicate = await env.DB.prepare(
    `SELECT id FROM analytics_events
     WHERE page_id = ?
       AND (visitor_id = ? OR session_id = ?)
       AND created_at >= datetime('now', ?)
     LIMIT 1`
  ).bind(pageId, visitorId, sessionId, `-${DUPLICATE_WINDOW_SECONDS} seconds`).first<{ id: number }>();

  if (duplicate) {
    const stats = await getPageStats(env, pageId);
    return { stats, writePromise: Promise.resolve() };
  }

  // 阶段2：判断是否是新访客/新会话（用于决定 visitors/sessions 是否 +1）
  const date = today();
  const [existingVisitor, existingSession] = await Promise.all([
    env.DB.prepare(
      'SELECT 1 FROM analytics_daily_visitors WHERE date = ? AND page_id = ? AND visitor_id = ?'
    ).bind(date, pageId, visitorId).first(),
    env.DB.prepare(
      'SELECT 1 FROM analytics_daily_sessions WHERE date = ? AND page_id = ? AND session_id = ?'
    ).bind(date, pageId, sessionId).first(),
  ]);
  const isNewVisitor = !existingVisitor;
  const isNewSession = !existingSession;

  // 阶段3：读取当前 page_totals 以构建乐观返回值
  const currentStats = await env.DB.prepare(
    `SELECT views, visitors, sessions, search_views, message_count
     FROM analytics_page_totals WHERE page_id = ?`
  ).bind(pageId).first<{
    views: number; visitors: number; sessions: number; search_views: number; message_count: number;
  }>();

  const pageTitle = text(body.pageTitle, 300);
  // pageUrl/canonicalUrl were already normalized against the trusted Origin.
  const referrer = text(body.referrer, 1000);
  const referrerDomain = text(body.referrerDomain, 255);
  const utmSource = text(body.utm?.source, 100);
  const utmMedium = text(body.utm?.medium, 100);
  const utmCampaign = text(body.utm?.campaign, 150);
  const channel = normalizeChannel(body.channel);
  const channelColumn = CHANNEL_COLUMNS[channel];
  const messageCount = currentStats?.message_count || 0;

  // 阶段4：构建乐观返回值（基于 currentStats + 1，无需等写入完成）
  const baseViews = currentStats?.views || 0;
  const baseVisitors = currentStats?.visitors || 0;
  const baseSessions = currentStats?.sessions || 0;
  const baseSearchViews = currentStats?.search_views || 0;

  const optimisticStats: PageStats = {
    pageId,
    pageTitle,
    pageUrl,
    canonicalUrl,
    views: baseViews + 1,
    visitors: baseVisitors + (isNewVisitor ? 1 : 0),
    sessions: baseSessions + (isNewSession ? 1 : 0),
    searchViews: baseSearchViews + (channel === 'search' ? 1 : 0),
    messageCount,
  };

  // 阶段4：D1 Batch 写入（可由调用方通过 ctx.waitUntil() 异步执行）
  const writePromise = env.DB.batch([
    // 4a. 插入原始事件
    env.DB.prepare(
      `INSERT INTO analytics_events (
         page_id, page_title, page_url, canonical_url, referrer, referrer_domain,
         utm_source, utm_medium, utm_campaign, channel, country, device_type,
         screen_width, screen_height, viewport_width, viewport_height,
         language, timezone, ip_address, visitor_id, session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      pageId, pageTitle, pageUrl, canonicalUrl, referrer, referrerDomain,
      utmSource, utmMedium, utmCampaign, channel,
      request.headers.get('CF-IPCountry') || '',
      text(body.deviceType, 20),
      int(body.screen?.width), int(body.screen?.height),
      int(body.viewport?.width), int(body.viewport?.height),
      text(body.language, 50), text(body.timezone, 80),
      clientIp, visitorId, sessionId
    ),
    // 4b. 去重访客
    env.DB.prepare(
      'INSERT OR IGNORE INTO analytics_daily_visitors (date, page_id, visitor_id) VALUES (?, ?, ?)'
    ).bind(date, pageId, visitorId),
    // 4c. 去重会话
    env.DB.prepare(
      'INSERT OR IGNORE INTO analytics_daily_sessions (date, page_id, session_id) VALUES (?, ?, ?)'
    ).bind(date, pageId, sessionId),
    // 4d. 日聚合
    env.DB.prepare(
      `INSERT INTO analytics_page_daily (
         date, page_id, page_title, page_url, canonical_url, views, visitors, sessions, ${channelColumn}, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1, datetime('now', '+8 hours'))
       ON CONFLICT(date, page_id) DO UPDATE SET
         page_title = excluded.page_title,
         page_url = excluded.page_url,
         canonical_url = excluded.canonical_url,
         views = analytics_page_daily.views + 1,
         visitors = analytics_page_daily.visitors + ?,
         sessions = analytics_page_daily.sessions + ?,
         ${channelColumn} = ${channelColumn} + 1,
         updated_at = datetime('now', '+8 hours')`
    ).bind(date, pageId, pageTitle, pageUrl, canonicalUrl, isNewVisitor ? 1 : 0, isNewSession ? 1 : 0, isNewVisitor ? 1 : 0, isNewSession ? 1 : 0),
    // 4e. 总聚合
    env.DB.prepare(
      `INSERT INTO analytics_page_totals (
         page_id, page_title, page_url, canonical_url, views, visitors, sessions, search_views, message_count, last_view_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
       ON CONFLICT(page_id) DO UPDATE SET
         page_title = excluded.page_title,
         page_url = excluded.page_url,
         canonical_url = excluded.canonical_url,
         views = analytics_page_totals.views + 1,
         visitors = analytics_page_totals.visitors + ?,
         sessions = analytics_page_totals.sessions + ?,
         search_views = analytics_page_totals.search_views + ?,
         message_count = max(analytics_page_totals.message_count, excluded.message_count),
         last_view_at = datetime('now', '+8 hours'),
         updated_at = datetime('now', '+8 hours')`
    ).bind(pageId, pageTitle, pageUrl, canonicalUrl, isNewVisitor ? 1 : 0, isNewSession ? 1 : 0, channel === 'search' ? 1 : 0, messageCount, isNewVisitor ? 1 : 0, isNewSession ? 1 : 0, channel === 'search' ? 1 : 0),
  ]).then(() => {});

  return { stats: optimisticStats, writePromise };
}

export async function adjustMessageCount(
  env: Env,
  pageId: string,
  pageUrl: string,
  createdAt: string | null | undefined,
  delta: number
): Promise<void> {
  if (!pageId || delta === 0) return;

  const date = dateFromCreatedAt(createdAt);

  await env.DB.prepare(
    `INSERT INTO analytics_page_totals (page_id, page_url, message_count, last_message_at, updated_at)
     VALUES (?, ?, max(0, ?), datetime('now', '+8 hours'), datetime('now', '+8 hours'))
     ON CONFLICT(page_id) DO UPDATE SET
       page_url = CASE WHEN excluded.page_url != '' THEN excluded.page_url ELSE analytics_page_totals.page_url END,
       message_count = max(0, analytics_page_totals.message_count + ?),
       last_message_at = datetime('now', '+8 hours'),
       updated_at = datetime('now', '+8 hours')`
  ).bind(pageId, pageUrl || '', delta, delta).run();

  await env.DB.prepare(
    `INSERT INTO analytics_page_daily (date, page_id, page_url, message_count, updated_at)
     VALUES (?, ?, ?, max(0, ?), datetime('now', '+8 hours'))
     ON CONFLICT(date, page_id) DO UPDATE SET
       page_url = CASE WHEN excluded.page_url != '' THEN excluded.page_url ELSE analytics_page_daily.page_url END,
       message_count = max(0, analytics_page_daily.message_count + ?),
       updated_at = datetime('now', '+8 hours')`
  ).bind(date, pageId, pageUrl || '', delta, delta).run();
}
