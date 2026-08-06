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

export function CreateTokenDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState("7");
  const [singleUse, setSingleUse] = useState(true);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await clientPost("/tokens", {
        name,
        expiresDays: Number(days),
        singleUse,
      });
      setOpen(false);
      setName("");
      setDays("7");
      setSingleUse(true);
      router.refresh();
      success("令牌创建成功");
    } catch (err) {
      toastError(err, "创建失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>创建令牌</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建注册令牌</DialogTitle>
          <DialogDescription>
            生成后把令牌发给团队成员,用于 CLI 注册。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">备注名</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如:研发组"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="days">有效天数</Label>
            <Input
              id="days"
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              required
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={singleUse}
              onChange={(e) => setSingleUse(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-sm">一次性使用(用完即作废)</span>
          </label>
          {!singleUse && (
            <p className="text-xs text-muted-foreground">
              多次使用:有效期内不限注册次数,适合团队共用。
            </p>
          )}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "创建中…" : "创建"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
