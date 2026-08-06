import { z } from "zod";

/**
 * OAuth 2.0 Device Authorization Grant — 中间层对外契约(供 CLI 消费)。
 * 协议刻意对齐 RFC 8628 + lark-cli device flow,使 CLI 端无需特判。
 */

// POST /device_authorization 响应 (RFC 8628 §3.2)
export const DeviceAuthResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
export type DeviceAuthResponse = z.infer<typeof DeviceAuthResponseSchema>;

// POST /token 成功响应 (RFC 6749 §5.1)
export const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// RFC 6749 §5.2 / RFC 8628 §3.5 错误码
export const OAuthErrorCodeSchema = z.enum([
  "authorization_pending",
  "slow_down",
  "expired_token",
  "access_denied",
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unsupported_grant_type",
  "invalid_scope",
]);
export type OAuthErrorCode = z.infer<typeof OAuthErrorCodeSchema>;

export const OAuthErrorSchema = z.object({
  error: OAuthErrorCodeSchema,
  error_description: z.string().optional(),
});
export type OAuthError = z.infer<typeof OAuthErrorSchema>;

// GET /user_info 响应。字段名 open_id 对齐 lark-cli getUserInfo 的解析。
export const UserInfoResponseSchema = z.object({
  open_id: z.string(),
  name: z.string(),
});
export type UserInfoResponse = z.infer<typeof UserInfoResponseSchema>;
