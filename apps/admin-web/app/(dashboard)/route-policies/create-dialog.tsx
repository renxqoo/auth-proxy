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

export function CreateRoutePolicyDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pattern, setPattern] = useState("");
  const [scope, setScope] = useState("");
  const [method, setMethod] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await clientPost("/route-policies", {
        pattern,
        scope: scope || undefined,
        method: method || undefined,
        description: description || undefined,
      });
      setOpen(false);
      setPattern("");
      setScope("");
      setMethod("");
      setDescription("");
      router.refresh();
      success("策略已创建");
    } catch (err) {
      toastError(err, "创建失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>创建策略</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建路径策略</DialogTitle>
          <DialogDescription>
            配置某路径需要的 scope。pattern 用通配符(如 /api/orders*)。
            scope 留空 = 只需登录。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rp-pattern">pattern *</Label>
            <Input
              id="rp-pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="/api/reports*"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rp-scope">scope(留空 = 只需登录)</Label>
            <Input
              id="rp-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="orders:read"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rp-method">method(留空 = 全部方法)</Label>
            <Input
              id="rp-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              placeholder="GET"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rp-desc">说明(可选)</Label>
            <Input
              id="rp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="读报表"
            />
          </div>
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "创建中..." : "创建"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
