"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clientDelete } from "@/lib/api";
import { success, error as toastError } from "@/lib/toast";
import { PasswordDialog } from "./password-dialog";
import { RenameDialog } from "./rename-dialog";

/**
 * 管理员行操作:重置密码 / 改用户名 / 删除。
 * - 改密码/改用户名:对所有人可用(isSelf 控制弹窗表单是否需要旧密码)
 * - 删除:不能删自己(后端也拦);仅剩 1 个时禁用(至少保留一个)
 */
export function AdminActions({
  id,
  total,
  isSelf,
  currentName,
}: {
  id: number;
  total: number;
  isSelf: boolean;
  currentName: string;
}) {
  const router = useRouter();
  const lastOne = total <= 1;
  // 删除禁用条件:是自己 或 是最后一个
  const deleteDisabled = isSelf || lastOne;
  const deleteTitle = isSelf
    ? "不能删除自己"
    : lastOne
      ? "至少保留一个管理员"
      : undefined;

  async function del() {
    if (deleteDisabled) return;
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
    <div className="flex justify-end gap-2">
      <PasswordDialog id={id} isSelf={isSelf} />
      <RenameDialog id={id} isSelf={isSelf} currentName={currentName} />
      <Button
        variant="destructive"
        size="sm"
        onClick={del}
        disabled={deleteDisabled}
        title={deleteTitle}
      >
        删除
      </Button>
    </div>
  );
}
