// functions/api/v1/auth/register.ts — 用户注册
import { apiHandler, getClientIp } from '../../../../lib/middleware';
import { hashPassword } from '../../../../lib/crypto';
import { verifyTurnstileForRequest } from '../../../../lib/turnstile';
import { sendEmail, buildVerifyEmailHtml } from '../../../../lib/email';
import { createTokensForUser } from '../../../../lib/auth';
import { getAvatarUrl } from '../../../../lib/avatar';
import { generateToken, hashToken } from '../../../../lib/jwt';
import { sanitizeUsername, sanitizeEmail, validatePasswordStrength, validateEmail, validatePhone, toDbDatetime } from '../../../../lib/sanitize';
import { ErrorCode, errorResponse } from '../../../../lib/response';
import type { Env, DbUser } from '../../../../lib/types';

export const onRequestPost = apiHandler(async (request, env, ctx) => {
  const body = await request.json() as {
    username: string;
    email: string;
    phone: string;
    password: string;
    turnstileToken: string;
  };

  // 验证必填字段
  if (!body.username || !body.email || !body.phone || !body.password) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, '请填写所有必填字段', 400);
  }

  // Turnstile 验证（统一封装，含紧急降级开关）
  const tsRes = await verifyTurnstileForRequest(request, body.turnstileToken, env);
  if (tsRes) {
    return errorResponse(tsRes.code, tsRes.message, 400);
  }

  // IP 频率限制检查（10分钟内最多3次）
  const clientIp = getClientIp(request);
  const tenMinutesAgo = toDbDatetime(new Date(Date.now() - 10 * 60 * 1000));
  const attempts = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM register_attempts WHERE ip_address = ? AND created_at > ?'
  ).bind(clientIp, tenMinutesAgo).first<{ count: number }>();

  if (attempts && attempts.count >= 3) {
    return errorResponse(ErrorCode.RATE_LIMITED, '注册尝试过于频繁，请 10 分钟后再试', 429);
  }

  // 记录此次注册尝试
  await env.DB.prepare(
    'INSERT INTO register_attempts (ip_address) VALUES (?)'
  ).bind(clientIp).run();

  // 用户名统一小写化，避免注册/登录大小写不一致导致无法登录
  const username = sanitizeUsername(body.username).toLowerCase();
  const email = sanitizeEmail(body.email);
  const phone = body.phone.trim();
  const password = body.password;

  // 验证用户名格式
  if (username.length < 2 || username.length > 30) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, '用户名长度需在 2-30 之间', 400);
  }

  // 验证密码强度
  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, passwordError, 400);
  }

  // 严格验证邮箱格式
  const emailError = validateEmail(email);
  if (emailError) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, emailError, 400);
  }

  // 严格验证手机号格式
  const phoneError = validatePhone(phone);
  if (phoneError) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, phoneError, 400);
  }

  // 检查注册开关
  const config = await env.DB.prepare('SELECT allow_registration FROM board_config WHERE id = 1').first<{ allow_registration: number }>();
  if (config && !config.allow_registration) {
    return errorResponse(ErrorCode.REGISTRATION_DISABLED, '注册功能已关闭', 403);
  }

  // 查重（模糊提示，防用户枚举）
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ? OR phone = ?'
  ).bind(username, email, phone).first();
  if (existing) {
    return errorResponse(ErrorCode.USERNAME_TAKEN, '注册失败，用户名、邮箱或手机号可能已被占用，请更换后重试', 409);
  }

  // 创建用户（角色始终为普通用户；首个管理员通过 /setup 初始化）
  const passwordHash = await hashPassword(password);
  const avatar = getAvatarUrl(email);

  const result = await env.DB.prepare(
    `INSERT INTO users (username, email, phone, password_hash, avatar) VALUES (?, ?, ?, ?, ?)`
  ).bind(username, email, phone, passwordHash, avatar).run();

  const userId = result.meta.last_row_id as number;

  // 生成双 Token（统一封装）
  const { accessToken, refreshToken, refreshExpiry } = await createTokensForUser(env, userId, username, 'user');

  // 创建邮箱验证 token
  const verifyToken = generateToken();
  const verifyTokenHash = await hashToken(verifyToken);
  const verifyExpires = toDbDatetime(new Date(Date.now() + 24 * 3600 * 1000));
  await env.DB.prepare(
    `INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)`
  ).bind(userId, verifyTokenHash, verifyExpires).run();

  // 发送验证邮件（异步，不阻塞响应）
  const verifyUrl = `${env.PUBLIC_URL}/api/v1/auth/verify-email?token=${verifyToken}`;
  const html = buildVerifyEmailHtml(username, verifyUrl);
  ctx.waitUntil(sendEmail({ to: email, subject: '请验证您的邮箱', html }, env).catch(() => {}));

  // 获取完整用户信息
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>();

  return new Response(JSON.stringify({
    success: true,
    data: {
      accessToken,
      user: {
        id: user!.id,
        username: user!.username,
        displayName: user!.display_name || user!.username,
        email: user!.email,
        phone: user!.phone,
        emailVerified: user!.email_verified === 1,
        avatar: user!.avatar,
        role: 'user',
      },
    },
  }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `refresh_token=${refreshToken}; HttpOnly; Secure; SameSite=None; Path=/api/v1/auth; Max-Age=${refreshExpiry}`,
    },
  });
}, { requireAuth: false });
