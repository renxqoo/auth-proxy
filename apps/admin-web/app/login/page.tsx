import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { serverGet } from "@/lib/api";

/**
 * 登录页。已登录则跳 dashboard。
 * serverGet /me 校验 cookie:有效说明已登录,直接 redirect。
 */
export default async function LoginPage() {
  try {
    const cookieStore = await cookies();
    const cookie = cookieStore.toString();
    await serverGet("/me", cookie);
    redirect("/");
  } catch {
    /* 未登录,渲染登录表单 */
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/50 px-4">
      <LoginForm />
    </div>
  );
}

/**
 * server action:处理登录表单提交。
 * 定义在模块级(不捕获父作用域变量),透传 server 的 Set-Cookie。
 */
async function handleLogin(formData: FormData) {
  "use server";
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const serverBase = process.env.SERVER_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${serverBase}/admin/web/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) return;
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length === 0) {
    redirect("/");
    return;
  }
  const cookieStore = await cookies();
  const [first] = setCookie;
  if (!first) {
    redirect("/");
    return;
  }
  // 解析 name=value; attrs
  const [pair, ...rest] = first.split(";");
  const eqIdx = pair.indexOf("=");
  if (eqIdx <= 0) {
    redirect("/");
    return;
  }
  const name = pair.slice(0, eqIdx).trim();
  const value = pair.slice(eqIdx + 1).trim();
  const attrs = rest.join("; ");
  const maxAgeMatch = attrs.match(/max-age=(\d+)/i);
  cookieStore.set(name, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    ...(maxAgeMatch ? { maxAge: Number(maxAgeMatch[1]) } : {}),
  });
  redirect("/");
}

function LoginForm() {
  return (
    <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow">
      <h1 className="mb-1 text-xl font-semibold">Super CLI 管理后台</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        登录以管理令牌与客户端
      </p>
      <form action={handleLogin} className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="username" className="text-sm font-medium">
            用户名
          </label>
          <input
            id="username"
            name="username"
            type="text"
            required
            autoFocus
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            密码
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1"
          />
        </div>
        <button
          type="submit"
          className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90"
        >
          登录
        </button>
      </form>
    </div>
  );
}
