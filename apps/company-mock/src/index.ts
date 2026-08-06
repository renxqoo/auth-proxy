import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import {
  CompanyLoginRequestSchema,
  CompanyRefreshRequestSchema,
  type CompanyTokenResponse,
} from "@auth-proxy/shared";
import { authenticate, listUsers, profileOf } from "./users.js";
import { getTokenStore, type TokenRecord } from "./tokenStore.js";
import {
  invoicesByUser,
  orderDetail,
  ordersByUser,
  productById,
  PRODUCTS,
} from "./data.js";

/**
 * @auth-proxy/company-mock —— mock 公司应用。
 * 暴露鉴权 + 一组示例业务接口,供中间层消费。
 * 真实公司应用接入时,中间层的 company-auth 适配器对接相同形状的契约。
 *
 * 接口一览:
 *   POST /login                  账号密码换 token
 *   POST /refresh                refresh token 轮换
 *   GET  /me                     当前用户
 *   GET  /api/profile            当前用户资料
 *   GET  /api/orders             当前用户订单列表  [orders:read]
 *   GET  /api/orders/:id         订单详情(仅本人) [orders:read]
 *   GET  /api/products           商品目录          [products:read]
 *   GET  /api/products/:id       商品详情          [products:read]
 *   GET  /api/invoices           当前用户发票列表  [invoices:read]
 *   GET  /api/admin/users        全量用户(admin)   [admin]
 *   GET  /                       健康检查
 */

const app = new Hono();

// 从 Authorization 头解析 Bearer token
function bearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  return m?.[1];
}

// 把内部 TokenRecord 投影为对外响应
function toTokenResponse(rec: {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; scopes: string[] };
  expiresAt: number;
}): CompanyTokenResponse {
  return {
    access_token: rec.accessToken,
    refresh_token: rec.refreshToken,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.round((rec.expiresAt - Date.now()) / 1000)),
    user: rec.user,
  };
}

/**
 * 受保护接口的统一前置:校验 Bearer token 有效。
 * 失败直接返回 401 响应;成功返回记录,调用方继续做 scope 校验。
 *
 * 返回值用 `[TokenRecord, null] | [null, Response]` 做"成功/已响应"二选一,
 * 让路由代码写成 `const [rec, err] = requireAuth(c); if (err) return err;`,
 * 避免到处重复 token 解析 + 401 模板。
 */
function requireAuth(
  c: Context,
): [TokenRecord, null] | [null, Response] {
  const token = bearer(c.req.header("Authorization"));
  const rec = getTokenStore().findByAccess(token);
  if (!rec) {
    return [null, c.json({ error: "invalid_token" }, 401)];
  }
  return [rec, null];
}

/**
 * scope 校验:缺失返回 403 响应,否则返回 null。
 * 与 requireAuth 配合:
 *   const [rec, err] = requireAuth(c); if (err) return err;
 *   const denied = requireScope(c, rec, "orders:read"); if (denied) return denied;
 */
function requireScope(
  c: Context,
  rec: TokenRecord,
  scope: string,
): Response | null {
  if (!rec.user.scopes.includes(scope)) {
    return c.json({ error: "insufficient_scope" }, 403);
  }
  return null;
}

// ---------- POST /login ----------
app.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CompanyLoginRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const { username, password } = parsed.data;
  const user = authenticate(username, password);
  if (!user) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const rec = getTokenStore().issue(user);
  return c.json<CompanyTokenResponse>(toTokenResponse(rec), 200);
});

// ---------- POST /refresh ----------
app.post("/refresh", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CompanyRefreshRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const rec = getTokenStore().rotate(parsed.data.refresh_token);
  if (!rec) {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }
  return c.json<CompanyTokenResponse>(toTokenResponse(rec), 200);
});

// ---------- GET /me ----------
app.get("/me", (c) => {
  const token = bearer(c.req.header("Authorization"));
  const rec = getTokenStore().findByAccess(token);
  if (!rec) {
    return c.json({ error: "invalid_token" }, 401);
  }
  return c.json(rec.user, 200);
});

// ---------- GET /api/profile ----------
app.get("/api/profile", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const profile = profileOf(rec.user.id);
  if (!profile) {
    // 理论上不会发生(token 有效但用户被删);保守 404
    return c.json({ error: "profile_not_found" }, 404);
  }
  return c.json({ id: rec.user.id, ...profile }, 200);
});

// ---------- GET /api/orders (订单列表) ----------
app.get("/api/orders", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "orders:read");
  if (denied) return denied;
  // 数据可见性:只返回当前用户的订单(跨用户隔离)
  return c.json({ orders: ordersByUser(rec.user.id) }, 200);
});

// ---------- GET /api/orders/:id (订单详情) ----------
app.get("/api/orders/:id", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "orders:read");
  if (denied) return denied;
  // orderDetail 内部已按 userId 过滤:别人的订单也当 404,不泄露存在性
  const detail = orderDetail(rec.user.id, c.req.param("id"));
  if (!detail) {
    return c.json({ error: "order_not_found" }, 404);
  }
  return c.json(detail, 200);
});

// ---------- GET /api/products (商品目录) ----------
app.get("/api/products", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "products:read");
  if (denied) return denied;
  // 支持按 category 过滤:/api/products?category=电脑外设
  const category = c.req.query("category");
  const list = category
    ? PRODUCTS.filter((p) => p.category === category)
    : PRODUCTS;
  return c.json({ products: list, total: list.length }, 200);
});

// ---------- GET /api/products/:id (商品详情) ----------
app.get("/api/products/:id", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "products:read");
  if (denied) return denied;
  const product = productById(c.req.param("id"));
  if (!product) {
    return c.json({ error: "product_not_found" }, 404);
  }
  return c.json(product, 200);
});

// ---------- GET /api/invoices (发票列表) ----------
app.get("/api/invoices", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "invoices:read");
  if (denied) return denied;
  return c.json({ invoices: invoicesByUser(rec.user.id) }, 200);
});

// ---------- GET /api/admin/users (管理员:全量用户) ----------
app.get("/api/admin/users", (c) => {
  const [rec, err] = requireAuth(c);
  if (err) return err;
  const denied = requireScope(c, rec, "admin");
  if (denied) return denied;
  return c.json({ users: listUsers() }, 200);
});

// ---------- 健康检查 ----------
app.get("/", (c) => c.json({ service: "company-mock", ok: true }));

const port = Number(process.env.MOCK_PORT ?? 4000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[company-mock] listening on http://localhost:${info.port}`);
});
