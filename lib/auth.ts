// lib/auth.ts — 统一签发 Access / Refresh Token（消除 login/register/refresh/setup 中的重复逻辑）

import { signAccessToken, generateToken, hashToken, getRefreshTokenExpiry } from './jwt';
import { toDbDatetime } from './sanitize';
import type { Env } from './types';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiry: number;
}

/**
 * 为用户生成一对新的 Access + Refresh Token：
 * - Access Token 通过 JWT 签名返回（明文）
 * - Refresh Token 明文返回（由调用方写入 HttpOnly Cookie），哈希后入库
 */
export async function createTokensForUser(
  env: Env,
  userId: number,
  username: string,
  role: string
): Promise<IssuedTokens> {
  const accessToken = await signAccessToken({ userId, username, role }, env);
  const refreshToken = generateToken();
  const refreshTokenHash = await hashToken(refreshToken);
  const refreshExpiry = getRefreshTokenExpiry();
  const expiresAt = toDbDatetime(new Date(Date.now() + refreshExpiry * 1000));

  await env.DB.prepare(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).bind(userId, refreshTokenHash, expiresAt).run();

  return { accessToken, refreshToken, refreshExpiry };
}
