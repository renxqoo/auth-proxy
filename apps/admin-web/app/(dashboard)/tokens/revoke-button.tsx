"use client";
import { useRouter } from "next/navigation";
import { clientDelete } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

export function RevokeButton({ id }: { id: number }) {
  const router = useRouter();
  async function revoke() {
    if (!confirm("确定吊销此令牌?已用它注册的 client 不受影响,但不能再注册。")) return;
    try {
      await clientDelete(`/tokens/${id}`);
      router.refresh();
      success("令牌已吊销");
    } catch (err) {
      toastError(err, "吊销失败");
    }
  }
  return (
    <Button variant="destructive" size="sm" onClick={revoke}>
      吊销
    </Button>
  );
}
