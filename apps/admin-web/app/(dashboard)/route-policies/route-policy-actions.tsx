"use client";
import { useRouter } from "next/navigation";
import { clientDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

export function RoutePolicyActions({ id }: { id: number }) {
  const router = useRouter();

  async function del() {
    if (!confirm("确定删除此策略?删除后该路径将回到默认拒绝(403)。")) return;
    try {
      await clientDelete(`/route-policies/${id}`);
      router.refresh();
      success("策略已删除");
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
