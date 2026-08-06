import type { CompanyUser } from "@auth-proxy/shared";

/**
 * 预置测试账号 —— 模拟公司应用的用户目录。
 * 真实公司应用会查自己的库;mock 直接硬编码。
 *
 * scope 设计(覆盖各类边界,便于测中间层 gateway 的权限透传):
 * - orders:read   读订单列表/详情
 * - orders:write  下单/取消(本 mock 暂未实现写接口,scope 仅用于边界断言)
 * - products:read 读商品目录
 * - invoices:read 读发票
 * - admin         管理后台(用户列表等)
 *
 * 账号矩阵:
 * - alice  全权限(默认"啥都能干"的种子账号)
 * - bob    无任何 scope(纯权限边界:任何受保护接口都该 403)
 * - carol  只读订单 + 商品(典型业务用户)
 * - dave   只读发票(财务)
 * - erin   管理员(只有 admin,无业务 scope)
 */
interface MockAccount {
  password: string;
  user: CompanyUser;
  /** 用户资料:/api/profile 返回;真实公司应用一般另查 user_profile 表。 */
  profile: UserProfile;
}

export interface UserProfile {
  email: string;
  displayName: string;
  department: string;
  avatarUrl: string;
  createdAt: string; // ISO date
}

export const MOCK_ACCOUNTS: Record<string, MockAccount> = {
  alice: {
    password: "alice123",
    user: {
      id: "u_alice",
      name: "alice",
      scopes: [
        "orders:read",
        "orders:write",
        "products:read",
        "invoices:read",
        "admin",
      ],
    },
    profile: {
      email: "alice@example.com",
      displayName: "Alice Wang",
      department: "Engineering",
      avatarUrl: "https://i.pravatar.cc/128?img=1",
      createdAt: "2023-01-15T08:30:00Z",
    },
  },
  bob: {
    password: "bob123",
    user: { id: "u_bob", name: "bob", scopes: [] }, // 无 scope,测权限边界
    profile: {
      email: "bob@example.com",
      displayName: "Bob Li",
      department: "Marketing",
      avatarUrl: "https://i.pravatar.cc/128?img=2",
      createdAt: "2023-03-22T10:00:00Z",
    },
  },
  carol: {
    password: "carol123",
    user: { id: "u_carol", name: "carol", scopes: ["orders:read", "products:read"] },
    profile: {
      email: "carol@example.com",
      displayName: "Carol Zhang",
      department: "Sales",
      avatarUrl: "https://i.pravatar.cc/128?img=3",
      createdAt: "2023-05-10T14:20:00Z",
    },
  },
  dave: {
    password: "dave123",
    user: { id: "u_dave", name: "dave", scopes: ["invoices:read"] },
    profile: {
      email: "dave@example.com",
      displayName: "Dave Chen",
      department: "Finance",
      avatarUrl: "https://i.pravatar.cc/128?img=4",
      createdAt: "2022-11-01T09:00:00Z",
    },
  },
  erin: {
    password: "erin123",
    user: { id: "u_erin", name: "erin", scopes: ["admin"] },
    profile: {
      email: "erin@example.com",
      displayName: "Erin Zhao",
      department: "IT Admin",
      avatarUrl: "https://i.pravatar.cc/128?img=5",
      createdAt: "2022-06-18T16:45:00Z",
    },
  },
};

export function authenticate(
  username: string,
  password: string,
): CompanyUser | null {
  const acct = MOCK_ACCOUNTS[username];
  if (!acct || acct.password !== password) return null;
  return acct.user;
}

/** 按 userId 取资料(登录用户看自己 / admin 看任意人)。查不到返回 null。 */
export function profileOf(userId: string): UserProfile | null {
  for (const acct of Object.values(MOCK_ACCOUNTS)) {
    if (acct.user.id === userId) return acct.profile;
  }
  return null;
}

/** 所有账号的精简视图(/api/admin/users 用):不暴露密码。 */
export function listUsers(): Array<{
  id: string;
  name: string;
  scopes: string[];
  profile: UserProfile;
}> {
  return Object.values(MOCK_ACCOUNTS).map((a) => ({
    id: a.user.id,
    name: a.user.name,
    scopes: a.user.scopes,
    profile: a.profile,
  }));
}
