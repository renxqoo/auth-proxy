"use client";
import { useRouter } from "next/navigation";
import { clientDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

export function ScopeActions({
  id,
  isSystem,
}: {
  id: number;
  isSystem: boolean;
}) {
  const router = useRouter();

  async function del() {
    if (!confirm("确定删除此 scope?已绑定该 scope 的 client 将无法再请求它。")) return;
    try {
      await clientDelete(`/scopes/${id}`);
      router.refresh();
      success("scope 已删除");
    } catch (err) {
      toastError(err, "删除失败");
    }
  }

  if (isSystem) {
    return <span className="text-xs text-muted-foreground">不可删</span>;
  }

  return (
    <Button variant="destructive" size="sm" onClick={del}>
      删除
    </Button>
  );
}
