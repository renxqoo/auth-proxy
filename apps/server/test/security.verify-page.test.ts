import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /verify 登录页安全测试。
 *
 * 攻击面:
 * 1. 测试账号硬编码在页面 HTML(alice/alice123)→ 生产泄露可用凭据
 *    修复:仅非生产环境显示测试提示。
 * 2. XSS:user_code 来自查询参,直接插入 HTML → 必须 HTML 转义。
 *    验证:输入 <script>payload 不出现在原始形式。
 */

// mock deviceCodeStore + companyAuth(不依赖真实服务)
vi.mock("../src/deviceCodeStore.js", () => ({
  findDeviceCodeByUser: vi.fn(async () => null),
  authorizeDeviceCode: vi.fn(),
}));
vi.mock("../src/companyAuth.js", () => ({
  loginWithCompany: vi.fn(),
  CompanyAuthError: class extends Error {},
}));

// Redis mock(限流用)
const rlStore = new Map<string, { count: number; expireAt: number }>();
vi.mock("../src/infra.js", () => ({
  getRedis: () => ({
    incr: async (k: string) => {
      const now = Date.now();
      const e = rlStore.get(k);
      if (e && e.expireAt > now) return ++e.count;
      rlStore.set(k, { count: 1, expireAt: now + 60_000 });
      return 1;
    },
    expire: async (k: string, s: number) => {
      const e = rlStore.get(k);
      if (e) e.expireAt = Date.now() + s * 1000;
      return 1;
    },
    // 原子 Lua(模拟 enforceRateLimit 真实路径)
    eval: async (_s: string, _n: number, k: string, exp: string) => {
      const now = Date.now();
      const e = rlStore.get(k);
      if (e && e.expireAt > now) {
        e.count++;
        return [e.count, Math.ceil((e.expireAt - now) / 1000)];
      }
      const ttl = Number(exp);
      rlStore.set(k, { count: 1, expireAt: now + ttl * 1000 });
      return [1, ttl];
    },
    set: async () => "OK",
    get: async () => null,
    del: async () => 1,
  }),
}));

import { verify } from "../src/routes/verify.js";

beforeEach(() => {
  vi.clearAllMocks();
  rlStore.clear();
});

async function getLogin(userCode: string, env = "development") {
  vi.stubEnv("NODE_ENV", env);
  const res = await verify.request(
    `http://localhost/?user_code=${encodeURIComponent(userCode)}`,
    { method: "GET" },
  );
  vi.unstubAllEnvs();
  return res;
}

describe("SECURITY: 测试账号提示不应在生产环境泄露", () => {
  it("生产环境:登录页不含 alice/bob 测试账号提示", async () => {
    const res = await getLogin("ABCD-EFGH", "production");
    const html = await res.text();
    expect(html).not.toContain("alice");
    expect(html).not.toContain("alice123");
    expect(html).not.toContain("bob");
    expect(html).not.toContain("bob123");
    expect(html).not.toContain("测试账号");
  });

  it("开发环境:登录页可以包含测试账号提示(开发便利)", async () => {
    const res = await getLogin("ABCD-EFGH", "development");
    const html = await res.text();
    // 开发环境允许显示(回归保护:不能误删导致开发也看不到)
    expect(html).toContain("alice");
  });
});

describe("SECURITY: XSS —— user_code 必须被 HTML 转义", () => {
  it("user_code 含 <script> → 页面里不出现未转义的 <script>", async () => {
    const payload = '<script>alert(1)</script>';
    const res = await getLogin(payload, "production");
    const html = await res.text();
    // 原始 <script> 不能出现在 value 里(应该被转成 &lt;script&gt;)
    expect(html).not.toContain(`value="${payload}"`);
    expect(html).not.toContain(`>${payload}<`);
  });

  it("user_code 含引号注入尝试 → 属性边界不被破坏", async () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const res = await getLogin(payload, "production");
    const html = await res.text();
    // 关键安全属性:未转义的 " 不能出现(否则可闭合 value 属性注入新属性)
    // escapeAttr 把 " → &quot;,所以原始 "><img 序列不会出现
    expect(html).not.toContain('"><img');
    expect(html).not.toContain('" >');
    // 额外:确认 value 属性里是转义后的 &quot;
    expect(html).toContain("&quot;");
  });

  it("user_code 含 SVG onload 等事件处理器 → 被转义", async () => {
    const payload = '<svg onload=alert(1)>';
    const res = await getLogin(payload, "production");
    const html = await res.text();
    expect(html).not.toContain('<svg onload');
  });

  it("正常 user_code 原样显示(不误伤合法输入)", async () => {
    const res = await getLogin("ABCD-1234", "production");
    const html = await res.text();
    expect(html).toContain("ABCD-1234");
  });
});

describe("SECURITY: CSRF 双重提交 —— cookie 必须设置", () => {
  it("GET 登录页 → Set-Cookie 带 csrf=...", async () => {
    const res = await getLogin("ABCD-EFGH", "production");
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/csrf=[0-9a-f]+/);
    expect(setCookie!.toLowerCase()).toContain("httponly");
    expect(setCookie!.toLowerCase()).toContain("samesite=lax");
  });
});

/**
 * 回归:首次登录失败后,失败分支必须同步刷新 cookie + 表单 token,
 * 否则第二次提交会因 cookie/表单 token 不同步而误判 CSRF 失败。
 *
 * 复现路径(GET 与 POST 失败分支共享同一渲染函数):
 * 1. GET  → 返回表单 token T1(假设无 cookie)
 * 2. POST 失败(密码错) → 返回新表单 token T2,且必须同时下发新 cookie C2
 * 3. POST 带 C2 + T2 → 必须能通过 CSRF 校验(不再被误拒)
 */
describe("SECURITY: CSRF 失败重试 —— 表单 token 与 cookie 必须同步轮换", () => {
  it("失败分支的响应同时带 Set-Cookie 与匹配的表单 token", async () => {
    // GET 取首份 token(无 cookie,触发 CSRF 失败分支)
    const res1 = await verify.request("http://localhost/", { method: "GET" });
    const html1 = await res1.text();
    const token1 = html1.match(/csrf_token" value="([0-9a-f]+)"/)![1];

    // 第一次 POST:不携带 cookie → 命中 CSRF 失败分支
    const res2 = await verify.request("http://localhost/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_code: "ABCD-EFGH",
        username: "alice",
        password: "x",
        csrf_token: token1,
      }).toString(),
    });
    const html2 = await res2.text();

    // 关键断言:失败分支必须下发新 cookie
    const setCookie2 = res2.headers.get("set-cookie");
    expect(setCookie2).toBeTruthy();
    expect(setCookie2).toMatch(/csrf=[0-9a-f]+/);
    const cookieToken2 = setCookie2!.match(/csrf=([0-9a-f]+)/)![1];
    // 且表单里的 token 必须与刚下发的 cookie 一致(失同步是旧 bug 的根因)
    const formToken2 = html2.match(/csrf_token" value="([0-9a-f]+)"/)![1];
    expect(formToken2).toBe(cookieToken2);
    // 新 token 应已轮换(与首份不同)
    expect(formToken2).not.toBe(token1);
  });
});
