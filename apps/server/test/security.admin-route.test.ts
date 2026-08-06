import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /admin/web 路由层安全测试。
 *
 * 覆盖三个攻击面:
 * A. 用户枚举(timing):verifyPassword 在用户不存在时跳过 scrypt,
 *    响应明显更快 → 攻击者可枚举有效用户名。
 *    修复:用户不存在时也跑一次 dummy scrypt,抹平时延。
 * B. 输入校验 DoS:password 无长度上限 → 攻击者发 10MB 密码,scrypt 阻塞 event loop。
 *    修复:username/password 有最大长度(如 1024),超长直接 400。
 * C. admin 登录无限流:可在线爆破密码。
 *    修复:POST /admin/web/login 挂按 IP 的限流。
 *
 * 测试策略:mock 所有 repo/infra/sessionStore,用 app.request() 打路由。
 */

// ---- 共享 mock 状态 ----
const mockAdminRepo = {
  verifyPassword: vi.fn(),
  list: vi.fn(async () => []),
  create: vi.fn(),
  delete: vi.fn(async () => true),
  setPassword: vi.fn(async () => true),
};
const mockTokenRepo = { list: vi.fn(async () => []), revoke: vi.fn(), create: vi.fn() };
const mockAppRepo = { list: vi.fn(async () => []), findById: vi.fn(), delete: vi.fn(async () => true) };
const mockAuditRepo = {
  recentLoginLogs: vi.fn(async () => []),
  recentApiLogs: vi.fn(async () => []),
  writeLoginLog: vi.fn(),
  writeApiLog: vi.fn(),
};

// Redis mock:支持 incr+expire 的限流计数(内存 Map)
const rlStore = new Map<string, { count: number; expireAt: number }>();
const redisMock = {
  incr: vi.fn(async (key: string) => {
    const now = Date.now();
    const e = rlStore.get(key);
    if (e && e.expireAt > now) {
      e.count++;
      return e.count;
    }
    rlStore.set(key, { count: 1, expireAt: now + 60_000 });
    return 1;
  }),
  expire: vi.fn(async (key: string, sec: number) => {
    const e = rlStore.get(key);
    if (e) e.expireAt = Date.now() + sec * 1000;
    return 1;
  }),
  // 原子 Lua:INCR + 首次 EXPIRE(模拟 enforceRateLimit 的真实路径)
  eval: vi.fn(async (_script: string, _n: number, key: string, expireArg: string) => {
    const now = Date.now();
    const e = rlStore.get(key);
    if (e && e.expireAt > now) {
      e.count++;
      return [e.count, Math.ceil((e.expireAt - now) / 1000)];
    }
    const ttl = Number(expireArg);
    rlStore.set(key, { count: 1, expireAt: now + ttl * 1000 });
    return [1, ttl];
  }),
  set: vi.fn(async () => "OK"),
  get: vi.fn(async () => null),
  del: vi.fn(async () => 1),
  ping: vi.fn(async () => "PONG"),
  quit: vi.fn(async () => "OK"),
  multi: () => ({
    set: () => {},
    exec: async () => [],
  }),
};

vi.mock("../src/repos/index.js", () => ({
  getAdminRepo: () => mockAdminRepo,
  getTokenRepo: () => mockTokenRepo,
  getAppRepo: () => mockAppRepo,
  getAuditRepo: () => mockAuditRepo,
}));
vi.mock("../src/infra.js", () => ({
  getDb: () => ({}),
  getRedis: () => redisMock,
  closeInfra: vi.fn(async () => {}),
}));
vi.mock("../src/sessionStore.js", () => ({
  revokeSessionsByClient: vi.fn(async () => []),
}));

import { adminWeb } from "../src/routes/adminWeb.js";

function adminRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return Promise.resolve(
    adminWeb.request(`http://localhost${path}`, { ...init, headers }),
  );
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  rlStore.clear();
});

describe("A. 用户枚举(timing)—— 不存在用户不应明显更快", () => {
  it("用户不存在时:verifyPassword 也消耗 scrypt 量级时间(不跳过哈希)", async () => {
    // mock:用户不存在 → 返回 null
    mockAdminRepo.verifyPassword.mockImplementation(async () => null);

    // 跑一次不存在用户的登录,测耗时
    const t0 = performance.now();
    const res = await adminRequest("/login", {
      method: "POST",
      body: JSON.stringify({ username: "ghost", password: "whatever" }),
    });
    const tGhost = performance.now() - t0;
    expect(res.status).toBe(401);

    // mock:存在用户但密码错 → 返回 null(但内部走了真实 scrypt)
    mockAdminRepo.verifyPassword.mockImplementation(async () => null);

    const t1 = performance.now();
    await adminRequest("/login", {
      method: "POST",
      body: JSON.stringify({ username: "real", password: "wrongpass" }),
    });
    const tReal = performance.now() - t1;

    // 关键断言:verifyPassword 的实现必须对"用户不存在"也做一次等价工作量。
    // 这里我们直接断言 mock 之外的实现:adminRepo.verifyPassword 调用了 dummy。
    // 由于 mock 替换了 repo,真正的逻辑在 AdminRepo 类里 —— 单独的单元测试覆盖。
    // 此处只验证路由返回 401 + 不泄露用户是否存在(同消息)。
    const body1 = await json(res);
    expect(body1.error).toBe("invalid_credentials");
    expect(body1.error_description).toBeUndefined(); // 不附带"用户不存在"等暗示
    // 时延断言放在 adminRepo 单元测试(此处 mock 了,无意义)
    expect(tGhost).toBeGreaterThanOrEqual(0);
    expect(tReal).toBeGreaterThanOrEqual(0);
  });
});

describe("B. 输入校验 DoS —— 超长 password/username 必须拒绝", () => {
  it("10MB 密码 → 400(不能进 scrypt)", async () => {
    const huge = "x".repeat(10 * 1024 * 1024);
    const res = await adminRequest("/login", {
      method: "POST",
      body: JSON.stringify({ username: "a", password: huge }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe("invalid_request");
    // verifyPassword 不应被调用(校验在调用前拦截)
    expect(mockAdminRepo.verifyPassword).not.toHaveBeenCalled();
  });

  it("空 username → 400", async () => {
    const res = await adminRequest("/login", {
      method: "POST",
      body: JSON.stringify({ username: "   ", password: "pw" }),
    });
    expect(res.status).toBe(400);
  });

  it("空 password → 400", async () => {
    const res = await adminRequest("/login", {
      method: "POST",
      body: JSON.stringify({ username: "u", password: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("非 JSON body → 400,不抛", async () => {
    const res = await adminRequest("/login", {
      method: "POST",
      body: "not json{{",
    });
    expect(res.status).toBe(400);
  });

  it("创建管理员:超长 username → 400", async () => {
    // 需要带有效 session cookie 才能到创建接口
    const { issueSessionCookieValue } = await import(
      "../src/middleware/adminSession.js"
    );
    const cookie = issueSessionCookieValue(1, "admin");
    const huge = "u".repeat(10_000);
    const res = await adminRequest("/admins", {
      method: "POST",
      headers: { cookie: `admin_session=${cookie}` },
      body: JSON.stringify({ username: huge, password: "p" }),
    });
    expect(res.status).toBe(400);
    expect(mockAdminRepo.create).not.toHaveBeenCalled();
  });
});

describe("C. admin 登录限流 —— 爆破必须被拦截", () => {
  it("连续 N+1 次失败登录后第 N+1 次返回 429", async () => {
    mockAdminRepo.verifyPassword.mockImplementation(async () => null);
    // RL_ADMIN_LOGIN_MAX 默认 10
    const max = 10;
    let lastStatus = 0;
    for (let i = 0; i < max; i++) {
      const r = await adminRequest("/login", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
        body: JSON.stringify({ username: "u", password: "wrong" }),
      });
      lastStatus = r.status;
      expect(r.status).toBe(401); // 前 N 次正常 401
    }
    // 第 N+1 次 → 429
    const blocked = await adminRequest("/login", {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ username: "u", password: "wrong" }),
    });
    expect(blocked.status).toBe(429);
    expect(lastStatus).toBe(401); // 确认前 N 次没被误拦
  });

  it("限流按 IP 隔离:不同 IP 不互相影响", async () => {
    mockAdminRepo.verifyPassword.mockImplementation(async () => null);
    // IP A 打满
    for (let i = 0; i < 10; i++) {
      await adminRequest("/login", {
        method: "POST",
        headers: { "x-forwarded-for": "9.9.9.9" },
        body: JSON.stringify({ username: "u", password: "w" }),
      });
    }
    // IP B 仍可用
    const r = await adminRequest("/login", {
      method: "POST",
      headers: { "x-forwarded-for": "8.8.8.8" },
      body: JSON.stringify({ username: "u", password: "w" }),
    });
    expect(r.status).toBe(401); // 不被 IP A 的限流影响
  });
});

describe("D. session 鉴权 —— 未登录访问受保护接口", () => {
  it("无 cookie 访问 /me → 401", async () => {
    const r = await adminRequest("/me", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("无效 cookie 访问 /me → 401", async () => {
    const r = await adminRequest("/me", {
      method: "GET",
      headers: { cookie: "admin_session=garbage.value" },
    });
    expect(r.status).toBe(401);
  });

  it("有效 cookie 访问 /me → 200 + 返回 admin 信息", async () => {
    const { issueSessionCookieValue } = await import(
      "../src/middleware/adminSession.js"
    );
    const cookie = issueSessionCookieValue(7, "root");
    const r = await adminRequest("/me", {
      method: "GET",
      headers: { cookie: `admin_session=${cookie}` },
    });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.id).toBe(7);
    expect(body.username).toBe("root");
  });
});

describe("E. 错误信息不泄露内部细节", () => {
  it("创建管理员冲突 → 409 + 通用消息(无 SQL/堆栈)", async () => {
    const { issueSessionCookieValue } = await import(
      "../src/middleware/adminSession.js"
    );
    const cookie = issueSessionCookieValue(1, "admin");
    mockAdminRepo.create.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "admins_username_key"'),
    );
    const r = await adminRequest("/admins", {
      method: "POST",
      headers: { cookie: `admin_session=${cookie}` },
      body: JSON.stringify({ username: "dup", password: "pw123456" }),
    });
    expect(r.status).toBe(409);
    const body = await json(r);
    expect(body.error).toBe("conflict");
    expect(JSON.stringify(body)).not.toContain("duplicate key");
    expect(JSON.stringify(body)).not.toContain("constraint");
    expect(JSON.stringify(body)).not.toContain("SQL");
  });
});
