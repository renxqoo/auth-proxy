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

export function CreateScopeDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await clientPost("/scopes", { name, description });
      setOpen(false);
      setName("");
      setDescription("");
      router.refresh();
      success("scope 已创建");
    } catch (err) {
      toastError(err, "创建失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>创建 scope</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建 scope</DialogTitle>
          <DialogDescription>
            新增一个全局 scope 定义。name 需唯一(如 reports:read)。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="scope-name">name</Label>
            <Input
              id="scope-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="reports:read"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="scope-desc">说明(可选)</Label>
            <Input
              id="scope-desc"
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
