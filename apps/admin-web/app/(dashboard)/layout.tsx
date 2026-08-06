import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { serverGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import LogoutButton from "./logout-button";

/**
 * 后台 layout:校验登录态(/me),未登录跳 /login。
 * 带左侧导航 + 顶部当前用户 + 登出。
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let me: { id: number; username: string };
  try {
    const cookieStore = await cookies();
    me = await serverGet("/me", cookieStore.toString());
  } catch {
    redirect("/login");
  }

  const nav = [
    { href: "/", label: "概览" },
    { href: "/tokens", label: "注册令牌" },
    { href: "/apps", label: "客户端" },
    { href: "/audit", label: "审计日志" },
    { href: "/admins", label: "管理员" },
  ];

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r bg-muted/30 p-4 flex flex-col gap-1">
        <div className="mb-4 px-2">
          <div className="text-sm font-semibold">Super CLI</div>
          <div className="text-xs text-muted-foreground">管理后台</div>
        </div>
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col">
        <header className="h-14 border-b flex items-center justify-between px-6">
          <Badge variant="secondary">{me.username}</Badge>
          <LogoutButton />
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
