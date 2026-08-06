import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 攻击场景:publicBase 信任 x-forwarded-host → host header 注入 → 钓鱼。
 *
 * 漏洞:/device_authorization 用 publicBase() 拼 verification_uri 返回给 CLI。
 * publicBase 直接采用请求头 x-forwarded-host / x-forwarded-proto。
 * 若服务可被直接访问(未经可信反代,或反代不重写这些头),攻击者可发:
 *   x-forwarded-host: evil.attacker.com
 * 让 CLI 收到的登录链接是 https://evil.attacker.com/verify?user_code=...
 * 用户点开就在钓鱼站输账号密码。
 *
 * 修复:优先用配置的 PUBLIC_BASE_URL(env),没有时才回退到 host 头,
 *      但 x-forwarded-host 不能无条件信任(只信任配置或反代已重写的 host)。
 */

const redisRef: { redis: unknown } = {
  redis: { eval: async () => [1, 60] },
};
vi.mock("../src/infra.js", () => ({ getRedis: () => redisRef.redis }));
vi.mock("../src/repos/index.js", () => ({
  getAppRepo: () => ({ verifyClient: vi.fn(async (cid: string) => cid) }),
}));
const { createSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(async () => ({
    deviceCode: "dc_x",
    userCode: "ABCD-EFGH",
    clientId: "cli_test",
    scope: "offline_access",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  })),
}));
vi.mock("../src/deviceCodeStore.js", () => ({ createDeviceCode: createSpy }));

beforeEach(() => {
  vi.clearAllMocks();
  createSpy.mockResolvedValue({
    deviceCode: "dc_x",
    userCode: "ABCD-EFGH",
    clientId: "cli_test",
    scope: "offline_access",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  });
  delete process.env.PUBLIC_BASE_URL;
});

async function postDeviceAuth(headers: Record<string, string> = {}) {
  // 动态导入,确保 config 读最新 env
  vi.resetModules();
  const { deviceAuthorization } = await import(
    "../src/routes/deviceAuthorization.js"
  );
  const auth =
    "Basic " + Buffer.from("cli_test:secret").toString("base64");
  return deviceAuthorization.request("http://localhost/", {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: "scope=offline_access",
  });
}

describe("SECURITY: publicBase 不能被伪造的 x-forwarded-host 污染", () => {
  it("攻击:伪造 x-forwarded-host: evil.com,verification_uri 不能指向 evil.com", async () => {
    const res = await postDeviceAuth({
      "x-forwarded-host": "evil.attacker.com",
      "x-forwarded-proto": "https",
      host: "localhost:3000",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verification_uri: string };
    // 关键:返回的登录链接绝不能指向攻击者域名
    expect(body.verification_uri).not.toContain("evil.attacker.com");
    expect(body.verification_uri).not.toContain("evil");
  });

  it("配置了 PUBLIC_BASE_URL → verification_uri 使用配置值(忽略伪造头)", async () => {
    process.env.PUBLIC_BASE_URL = "https://auth.company.internal";
    const res = await postDeviceAuth({
      "x-forwarded-host": "evil.attacker.com",
      "x-forwarded-proto": "http",
    });
    const body = (await res.json()) as { verification_uri: string };
    expect(body.verification_uri).toBe("https://auth.company.internal/verify");
    expect(body.verification_uri).not.toContain("evil");
  });

  it("未配 PUBLIC_BASE_URL 且无伪造头 → 用 Host 头(本地开发场景)", async () => {
    const res = await postDeviceAuth({ host: "localhost:3000" });
    const body = (await res.json()) as { verification_uri: string };
    expect(body.verification_uri).toContain("localhost:3000/verify");
  });

  it("verification_uri_complete 含 user_code 且正确编码", async () => {
    process.env.PUBLIC_BASE_URL = "https://auth.example.com";
    const res = await postDeviceAuth();
    const body = (await res.json()) as {
      verification_uri_complete: string;
      user_code: string;
    };
    expect(body.verification_uri_complete).toBe(
      `https://auth.example.com/verify?user_code=${encodeURIComponent(body.user_code)}`,
    );
  });
});
