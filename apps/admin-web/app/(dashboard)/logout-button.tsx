"use client";
import { useRouter } from "next/navigation";
import { clientPost } from "@/lib/api";
import { success } from "@/lib/toast";

export default function LogoutButton() {
  const router = useRouter();
  async function logout() {
    try {
      await clientPost("/logout");
    } catch {
      /* ignore */
    }
    success("已退出登录");
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      onClick={logout}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      登出
    </button>
  );
}
