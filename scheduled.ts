// scheduled.ts — Cron Trigger 入口
// 当前项目留言相关表数据量极低（博客留言板场景），但以下清理可防止历史表无限增长：
// - analytics_events: 原始事件保留 90 天
// - email_verifications / password_resets: 过期或已使用的验证码定期清理
// - refresh_tokens: 过期或已吊销的令牌定期清理
import type { Env } from './lib/types';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // 清理流量统计原始事件（保留 90 天）
    const analyticsResult = await env.DB.prepare(
      `DELETE FROM analytics_events WHERE created_at < datetime('now', '-90 days')`
    ).run();
    console.log(`[Cron] Cleaned analytics_events: ${analyticsResult.meta.changes || 0}`);

    // 清理过期的邮箱验证记录
    const evResult = await env.DB.prepare(
      `DELETE FROM email_verifications WHERE expires_at < datetime('now')`
    ).run();
    console.log(`[Cron] Cleaned email_verifications: ${evResult.meta.changes || 0}`);

    // 清理过期或已使用的密码重置记录
    const prResult = await env.DB.prepare(
      `DELETE FROM password_resets WHERE expires_at < datetime('now') OR used = 1`
    ).run();
    console.log(`[Cron] Cleaned password_resets: ${prResult.meta.changes || 0}`);

    // 清理过期或已吊销的 Refresh Token
    const rtResult = await env.DB.prepare(
      `DELETE FROM refresh_tokens WHERE expires_at < datetime('now') OR revoked_at IS NOT NULL`
    ).run();
    console.log(`[Cron] Cleaned refresh_tokens: ${rtResult.meta.changes || 0}`);
  },
};
