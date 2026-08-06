"use client";
import { useRouter } from "next/navigation";
import { clientDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

export function DeleteAdminButton({ id }: { id: number }) {
  const router = useRouter();
  async function del() {
    if (!confirm("确定删除此管理员?此操作不可恢复。")) return;
    try {
      await clientDelete(`/admins/${id}`);
      router.refresh();
      success("管理员已删除");
    } catch (err) {
      toastError(err, "删除失败");
    }
  }
  return (
    <Button variant="destructive" size="sm" onClick={del}>
      删除
    </Button>
  );
}
