import {
  CompanyLoginRequestSchema,
  CompanyRefreshRequestSchema,
  CompanyTokenResponseSchema,
  type CompanyTokenResponse,
} from "@auth-proxy/shared";
import { config } from "./config.js";

/**
 * companyAuth —— 中间层与公司应用的适配层。
 *
 * 这是中间层里唯一接触公司应用的地方。真实公司应用接入时,
 * 如果契约不同,只改这一个文件(做字段映射),其余 server 代码不动。
 *
 * 当前对接 company-mock:POST /login, POST /refresh。
 */

export class CompanyAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanyAuthError";
  }
}

async function parseCompanyError(res: Response): Promise<never> {
  let code = "company_error";
  let detail = res.statusText;
  try {
    const body = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    code = body?.error ?? code;
    detail = body?.error_description ?? detail;
  } catch {
    /* 非 JSON 错误体,用 statusText */
  }
  throw new CompanyAuthError(res.status, code, detail);
}

export async function loginWithCompany(
  username: string,
  password: string,
): Promise<CompanyTokenResponse> {
  const req = CompanyLoginRequestSchema.parse({ username, password });
  const res = await fetch(`${config.companyApiBase}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) await parseCompanyError(res);
  const body = await res.json();
  return CompanyTokenResponseSchema.parse(body);
}

export async function refreshWithCompany(
  refreshToken: string,
): Promise<CompanyTokenResponse> {
  const req = CompanyRefreshRequestSchema.parse({
    refresh_token: refreshToken,
  });
  const res = await fetch(`${config.companyApiBase}/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) await parseCompanyError(res);
  const body = await res.json();
  return CompanyTokenResponseSchema.parse(body);
}
