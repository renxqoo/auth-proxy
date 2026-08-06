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
 * 改用户名弹窗。
 * 改自己时后端会重发 cookie 刷新 payload,RSC 重新拉 /me 即显示新名。
 */
export function RenameDialog({
  id,
  isSelf,
  currentName,
}: {
  id: number;
  isSelf: boolean;
  currentName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(currentName);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await clientPost(`/admins/${id}/rename`, { username });
      setOpen(false);
      router.refresh();
      success("用户名已更新");
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
          改用户名
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改用户名</DialogTitle>
          <DialogDescription>
            {isSelf
              ? "修改后你的登录名将变为新用户名。"
              : "修改该管理员的用户名。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">新用户名</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "保存中…" : "保存"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
