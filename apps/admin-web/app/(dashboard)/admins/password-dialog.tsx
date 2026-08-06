"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { clientPost } from "@/lib/api";
import { success, error as toastError } from "@/lib/toast";

/**
 * 改密码弹窗。
 * isSelf=true(改自己):需「旧密码 + 新密码 + 确认」,提交带 oldPassword。
 * isSelf=false(改他人):仅「新密码」,管理员直接重置,不带 oldPassword。
 */
export function PasswordDialog({
  id,
  isSelf,
}: {
  id: number;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  function reset() {
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // 改自己前端多一道确认校验(防误输);改他人只有一个新密码框
    if (isSelf && newPassword !== confirmPassword) {
      toastError(new Error("两次输入的新密码不一致"), "修改失败");
      return;
    }
    setLoading(true);
    try {
      await clientPost(`/admins/${id}/password`, {
        newPassword,
        ...(isSelf ? { oldPassword } : {}),
      });
      setOpen(false);
      reset();
      router.refresh();
      success("密码已更新");
    } catch (err) {
      toastError(err, "修改失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          重置密码
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isSelf ? "修改密码" : "重置密码"}</DialogTitle>
          <DialogDescription>
            {isSelf
              ? "修改自己的登录密码,需先验证旧密码。"
              : "为该管理员设置新密码。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {isSelf && (
            <div className="space-y-2">
              <Label htmlFor="oldPassword">旧密码</Label>
              <Input
                id="oldPassword"
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="newPassword">新密码</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          {isSelf && (
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">确认新密码</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
          )}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "保存中…" : "保存"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
