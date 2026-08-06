import { Hono, type Context } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  authorizeDeviceCode,
  findDeviceCodeByUser,
} from "../deviceCodeStore.js";
import { loginWithCompany } from "../companyAuth.js";
import { getAuditRepo } from "../repos/index.js";
import { safeError } from "../config.js";
import { rateLimit, getClientIp } from "../middleware/rateLimit.js";
import { config } from "../config.js";

/** 异步写登录审计,失败仅记日志,不阻断主流程。 */
function auditLogin(params: {
  userCode: string;
  username: string;
  clientId: string;
  success: boolean;
  ip?: string;
  userAgent?: string;
}): void {
  void getAuditRepo().writeLoginLog(params);
}

/** 生成 CSRF token(32 字节随机,hex)。 */
function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * 渲染登录页 + 同步写 CSRF cookie。
 *
 * 双重提交 cookie 要求:表单 token 与 cookie 必须始终是同一份。
 * 因此每次渲染页面都生成新 token,并把同一份值写进 cookie 和表单隐藏域,
 * 由这一个函数保证两者原子一致 —— 任何调用点都不会再出现"只换表单、漏发 cookie"。
 *
 * 安全动机:此前 POST /login 的失败分支单独调 newCsrfToken() 填表单却不刷新 cookie,
 * 导致"第一次密码错 → 第二次提交必 CSRF 失败"。这里把生成+下发收口到一处根除该路径。
 */
function renderLoginPageWithCsrf(
  c: Context,
  userCode: string,
  error: string | null,
): string {
  const csrfToken = newCsrfToken();
  c.header(
    "Set-Cookie",
    `csrf=${csrfToken}; HttpOnly; SameSite=Lax; Path=/verify; Max-Age=600`,
  );
  return renderLoginPage(userCode, error, csrfToken);
}

/** timingSafeEqual 比对两个 hex 字符串(长度不等直接 false)。 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** 从 Cookie 头解析指定 key。 */
function cookieValue(
  cookieHeader: string | undefined,
  key: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const m = new RegExp(`(?:^|;\\s*)${key}=([^;]+)`).exec(cookieHeader);
  return m?.[1];
}

/**
 * /verify —— 浏览器端的账号密码登录页。
 * 这是用户唯一接触账号密码的地方;CLI 只发 device_code,完全不接触用户凭证。
 *
 * GET  /verify?user_code=XXXX  渲染登录表单
 * POST /verify/login           提交账号密码,代调公司应用 /login,绑定到 device_code
 */
export const verify = new Hono();

// 登录提交按 IP 限流(防账号爆破)
verify.use(
  "/login",
  rateLimit({
    windowMs: config.rateLimit.loginWindowMs,
    limit: config.rateLimit.loginMax,
    prefix: "rl:login",
    keyGenerator: getClientIp,
  }),
);

verify.get("/", (c) => {
  const userCode = c.req.query("user_code") ?? "";
  return c.html(renderLoginPageWithCsrf(c, userCode, null));
});

verify.post("/login", async (c) => {
  const form = await c.req.parseBody();
  const userCode = String(form.user_code ?? "").trim();
  const username = String(form.username ?? "").trim();
  const password = String(form.password ?? "");
  const formCsrf = String(form.csrf_token ?? "");
  const cookieCsrf = cookieValue(c.req.header("cookie"), "csrf");

  // CSRF 校验(双重提交):cookie 与表单 token 必须匹配
  if (!formCsrf || !cookieCsrf || !safeEqualHex(formCsrf, cookieCsrf)) {
    return c.html(
      renderLoginPageWithCsrf(
        c,
        userCode,
        "CSRF 校验失败,请重新打开登录链接。",
      ),
    );
  }

  // 校验 user_code 存在且 pending
  const rec = await findDeviceCodeByUser(userCode);
  if (!rec) {
    return c.html(
      renderLoginPageWithCsrf(
        c,
        userCode,
        "无效或未知的用户码(user_code)。",
      ),
    );
  }
  if (rec.status !== "pending") {
    return c.html(
      renderLoginPageWithCsrf(
        c,
        userCode,
        "此用户码已使用或已过期,请回到 CLI 重新发起登录。",
      ),
    );
  }

  // 代调公司应用登录
  const clientId = rec.clientId;
  const ip = c.req.header("x-forwarded-for") ?? c.req.header("remote-address");
  const userAgent = c.req.header("user-agent");
  try {
    const companyToken = await loginWithCompany(username, password);
    await authorizeDeviceCode(userCode, companyToken);
    auditLogin({ userCode, username, clientId, success: true, ip, userAgent });
    return c.html(renderSuccessPage(companyToken.user.name));
  } catch (e) {
    // 完整错误记服务端日志,不暴露给前端(可能含数据库/内部信息)
    safeError("[verify] login failed:", e);
    auditLogin({ userCode, username, clientId, success: false, ip, userAgent });
    // 通用错误提示,不泄露内部细节
    return c.html(
      renderLoginPageWithCsrf(c, userCode, "账号或密码错误,请重试。"),
    );
  }
});

// ---------- 登录页 HTML(极简,内联 CSS) ----------
function renderLoginPage(
  userCode: string,
  error: string | null,
  csrfToken: string,
): string {
  const errHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Super CLI 登录</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);width:100%;max-width:360px}
    h1{font-size:1.25rem;margin:0 0 1rem}
    label{display:block;font-size:.875rem;color:#555;margin:.5rem 0 .25rem}
    input{width:100%;padding:.5rem;border:1px solid #ddd;border-radius:4px;box-sizing:border-box;font-size:1rem}
    button{width:100%;padding:.6rem;margin-top:1rem;background:#2563eb;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
    button:hover{background:#1d4ed8}
    .error{color:#dc2626;font-size:.85rem;margin:.5rem 0;background:#fef2f2;padding:.5rem;border-radius:4px}
    .hint{color:#888;font-size:.8rem;margin-top:1rem}
  </style>
</head>
<body>
  <form class="card" method="POST" action="/verify/login">
    <h1>登录公司应用</h1>
    <input type="hidden" name="user_code" value="${escapeAttr(userCode)}" />
    <input type="hidden" name="csrf_token" value="${escapeAttr(csrfToken)}" />
    <label for="username">账号</label>
    <input id="username" name="username" autocomplete="username" required autofocus />
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    ${errHtml}
    <button type="submit">登录</button>
    ${renderTestHint()}
  </form>
</body>
</html>`;
}

/**
 * 测试账号提示 —— 仅非生产环境显示。
 * 安全动机:登录页 HTML 里硬编码 alice/alice123 等测试凭据,在生产环境
 * 会被任何访问者看到,直接泄露可登录账号。生产环境(NODE_ENV=production)
 * 必须移除该提示。
 */
function renderTestHint(): string {
  if (process.env.NODE_ENV === "production") return "";
  return '<p class="hint">测试账号:alice / alice123(有权限)、bob / bob123(无权限)</p>';
}

function renderSuccessPage(userName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>登录成功</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
    .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;width:100%;max-width:360px}
    h1{color:#16a34a;font-size:1.25rem}
    .hint{color:#888;font-size:.875rem}
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ 登录成功</h1>
    <p>欢迎,${escapeHtml(userName)}</p>
    <p class="hint">请回到命令行,CLI 将自动完成登录。</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
