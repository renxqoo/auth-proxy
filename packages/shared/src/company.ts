import { z } from "zod";

/**
 * Mock 公司应用契约(中间层消费方)。
 * 这是本期自定义契约;真实公司应用接入时由中间层的 company-auth 适配器对齐。
 */

export const CompanyUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
});
export type CompanyUser = z.infer<typeof CompanyUserSchema>;

export const CompanyLoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type CompanyLoginRequest = z.infer<typeof CompanyLoginRequestSchema>;

export const CompanyRefreshRequestSchema = z.object({
  refresh_token: z.string().min(1),
});
export type CompanyRefreshRequest = z.infer<typeof CompanyRefreshRequestSchema>;

// /login + /refresh 成功响应
export const CompanyTokenResponseSchema = z.object({
  access_token: z.string(), // opaque (ct_ 前缀),中间层不解析
  refresh_token: z.string(), // opaque (cr_ 前缀)
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  user: CompanyUserSchema,
});
export type CompanyTokenResponse = z.infer<typeof CompanyTokenResponseSchema>;

// 公司应用错误(自定义,非标准 OAuth)
export const CompanyErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
export type CompanyError = z.infer<typeof CompanyErrorSchema>;
