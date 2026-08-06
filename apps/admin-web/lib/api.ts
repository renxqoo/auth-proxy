/**
 * 调中间层 server /admin/web/* 的封装。
 *
 * - 服务端调用(Server Components / Server Actions):SERVER_BASE_URL 直连(内网)
 * - 客户端调用(use client):走同源 /admin/web/* (next rewrites 代理,cookie 自动带)
 */

const API_BASE = "/admin/web";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  serverBase?: string,
): Promise<T> {
  const { headers, ...rest } = options;
  const base = serverBase ? `${serverBase}${API_BASE}` : API_BASE;
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...headers },
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body?.error_description ?? body?.error ?? msg;
    } catch {
      /* 非 JSON 错误 */
    }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// ---------- 服务端用(SERVER_BASE_URL)----------
export async function serverGet<T>(path: string, cookie?: string): Promise<T> {
  const serverBase = process.env.SERVER_BASE_URL ?? "http://localhost:3000";
  return request<T>(path, { headers: cookie ? { cookie } : {} }, serverBase);
}

// ---------- 客户端用(同源,cookie 自动)----------
export async function clientGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}
export async function clientPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}
export async function clientDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export { ApiError };
