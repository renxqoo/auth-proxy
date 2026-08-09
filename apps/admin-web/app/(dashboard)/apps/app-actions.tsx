"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientPost, clientDelete, clientGet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { success, error as toastError } from "@/lib/toast";

interface ScopeDef {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
}

/**
 * client 操作:
 * - 编辑 scope:限制该 client 能请求的 scope 子集(空 = 允许全部)
 * - 踢下线(POST /apps/:id/kick):吊销其所有 session
 * - 删除(DELETE /apps/:id):彻底删除
 */
export function AppActions({
  id,
  allowedScopes,
}: {
  id: number;
  allowedScopes: string[];
}) {
  const router = useRouter();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [allScopes, setAllScopes] = useState<ScopeDef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  async function openScopeEditor() {
    try {
      const { scopes } = await clientGet<{ scopes: ScopeDef[] }>("/scopes");
      setAllScopes(scopes);
      setSelected(new Set(allowedScopes));
      setScopeOpen(true);
    } catch (err) {
      toastError(err, "加载 scope 失败");
    }
  }

  function toggleScope(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function saveScopes() {
    setLoading(true);
    try {
      await clientPost(`/apps/${id}/scopes`, {
        scopes: [...selected],
      });
      setScopeOpen(false);
      router.refresh();
      success("scope 已更新");
    } catch (err) {
      toastError(err, "保存失败");
    } finally {
      setLoading(false);
    }
  }

  async function kick() {
    if (!confirm("确定踢下线?该客户端的所有会话立即失效,需重新登录(客户端本身不受影响)。")) return;
    try {
      const res = await clientPost<{ sessionsRevoked: number }>(`/apps/${id}/kick`);
      router.refresh();
      success(`已踢下线,吊销了 ${res.sessionsRevoked} 个会话`);
    } catch (err) {
      toastError(err, "操作失败");
    }
  }

  async function del() {
    if (!confirm("确定删除此客户端?该机器的 CLI 将无法登录,需重新 register。此操作不可恢复。")) return;
    try {
      await clientDelete(`/apps/${id}`);
      router.refresh();
      success("客户端已删除");
    } catch (err) {
      toastError(err, "删除失败");
    }
  }

  return (
    <div className="flex justify-end gap-2">
      <Dialog open={scopeOpen} onOpenChange={setScopeOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" onClick={openScopeEditor}>
            编辑 scope
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑允许的 scope</DialogTitle>
            <DialogDescription>
              勾选该客户端能请求的 scope。不勾任何项 = 允许全部已定义 scope。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {allScopes.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-3 rounded-md border p-2 cursor-pointer hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.name)}
                  onChange={() => toggleScope(s.name)}
                  className="h-4 w-4"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono">{s.name}</code>
                    {s.isSystem && (
                      <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        系统
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {s.description}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              全部允许(清空)
            </Button>
            <Button size="sm" onClick={saveScopes} disabled={loading}>
              {loading ? "保存中..." : "保存"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Button variant="outline" size="sm" onClick={kick}>
        踢下线
      </Button>
      <Button variant="destructive" size="sm" onClick={del}>
        删除
      </Button>
    </div>
  );
}
