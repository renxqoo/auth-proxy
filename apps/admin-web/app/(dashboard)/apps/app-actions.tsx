"use client";
import { useRouter } from "next/navigation";
import { clientPost, clientDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

/**
 * client 操作:
 * - 踢下线(POST /apps/:id/kick):吊销其所有 session,该机器需重新登录(但 client 仍可用)
 * - 删除(DELETE /apps/:id):彻底删除,该机器需重新 register
 */
export function AppActions({ id }: { id: number }) {
  const router = useRouter();

  async function kick() {
    if (!confirm("确定踢下线?该客户端的所有会话立即失效,需重新登录(客户端本身不受影响)。")) return;
    try {
      const res = await clientPost<{ sessionsRevoked: number }>(`/apps/${id}/kick`);
      router.refresh();
      success(`已踢下线,吊销了 ${res.sessionsRevoked} 个会话`);
    } catch (err) {
      toastError(err, "操作失败");
    }
  }

  async function del() {
    if (!confirm("确定删除此客户端?该机器的 CLI 将无法登录,需重新 register。此操作不可恢复。")) return;
    try {
      await clientDelete(`/apps/${id}`);
      router.refresh();
      success("客户端已删除");
    } catch (err) {
      toastError(err, "删除失败");
    }
  }

  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" onClick={kick}>
        踢下线
      </Button>
      <Button variant="destructive" size="sm" onClick={del}>
        删除
      </Button>
    </div>
  );
}
