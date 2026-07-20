// functions/api/v1/auth/setup.ts — 初始化首个管理员
// 仅当系统中不存在任何管理员时可用，且必须提供正确的 ADMIN_PASSWORD
import { apiHandler } from '../../../../lib/middleware';
import { hashPassword } from '../../../../lib/crypto';
import { createTokensForUser } from '../../../../lib/auth';
import { getAvatarUrl } from '../../../../lib/avatar';
import { generateToken, hashToken } from '../../../../lib/jwt';
import { sanitizeUsername, sanitizeEmail, validatePasswordStrength, validateEmail, validatePhone, toDbDatetime } from '../../../../lib/sanitize';
import { ErrorCode, errorResponse } from '../../../../lib/response';
import type { Env, DbUser } from '../../../../lib/types';

export const onRequestPost = apiHandler(async (request, env) => {
  const body = await request.json() as {
    username: string;
    email: string;
    phone?: string;
    password: string;
    adminPassword: string;
  };

  // 必须配置了 ADMIN_PASSWORD 才允许初始化（否则任何人都能创建管理员）
  if (!env.ADMIN_PASSWORD) {
    return errorResponse(ErrorCode.FORBIDDEN, '未配置管理员密码，无法初始化', 403);
  }
  if (!body.adminPassword || body.adminPassword !== env.ADMIN_PASSWORD) {
    return errorResponse(ErrorCode.FORBIDDEN, '管理员密码错误', 403);
  }

  // 已存在管理员则禁止重复初始化
  const adminCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM users WHERE role = 'admin'"
  ).first<{ count: number }>();
  if (adminCount && adminCount.count > 0) {
    return errorResponse(ErrorCode.SETUP_ALREADY_DONE, '管理员已存在，无需初始化', 409);
  }

  if (!body.username || !body.email || !body.password) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, '请填写用户名、邮箱和密码', 400);
  }

  // 用户名统一小写化，与注册逻辑保持一致
  const username = sanitizeUsername(body.username).toLowerCase();
  const email = sanitizeEmail(body.email);
  const phone = (body.phone || '').trim();

  if (username.length < 2 || username.length > 30) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, '用户名长度需在 2-30 之间', 400);
  }
  const passwordError = validatePasswordStrength(body.password);
  if (passwordError) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, passwordError, 400);
  }
  const emailError = validateEmail(email);
  if (emailError) {
    return errorResponse(ErrorCode.VALIDATION_ERROR, emailError, 400);
  }
  if (phone) {
    const phoneError = validatePhone(phone);
    if (phoneError) {
      return errorResponse(ErrorCode.VALIDATION_ERROR, phoneError, 400);
    }
  }

  // 查重（与注册逻辑一致）
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ? OR (phone IS NOT NULL AND phone != ? AND phone = ?)'
  ).bind(username, email, '', phone).first();
  if (existing) {
    return errorResponse(ErrorCode.USERNAME_TAKEN, '用户名或邮箱已被注册', 409);
  }

  const passwordHash = await hashPassword(body.password);
  const avatar = getAvatarUrl(email);
  const result = await env.DB.prepare(
    `INSERT INTO users (username, email, phone, password_hash, avatar, role, email_verified) VALUES (?, ?, ?, ?, ?, 'admin', 1)`
  ).bind(username, email, phone, passwordHash, avatar).run();
  const userId = result.meta.last_row_id as number;

  // 生成双 Token
  const { accessToken, refreshToken, refreshExpiry } = await createTokensForUser(env, userId, username, 'admin');

  // 创建邮箱验证 token（管理员邮箱已置 verified，但仍发出以便用户主动验证）
  const verifyToken = generateToken();
  const verifyTokenHash = await hashToken(verifyToken);
  const verifyExpires = toDbDatetime(new Date(Date.now() + 24 * 3600 * 1000));
  await env.DB.prepare(
    `INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)`
  ).bind(userId, verifyTokenHash, verifyExpires).run();

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
        role: user!.role,
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
