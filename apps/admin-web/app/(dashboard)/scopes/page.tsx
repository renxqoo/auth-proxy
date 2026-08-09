import { cookies } from "next/headers";
import { serverGet } from "@/lib/api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateScopeDialog } from "./create-dialog";
import { ScopeActions } from "./scope-actions";

interface ScopeRow {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: string;
}

export default async function ScopesPage() {
  const cookieStore = await cookies();
  const { scopes } = await serverGet<{ scopes: ScopeRow[] }>(
    "/scopes",
    cookieStore.toString(),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Scope 定义</h1>
          <p className="text-sm text-muted-foreground mt-1">
            全局 scope 词汇表(层 1)。客户端请求的 scope 必须在此定义过。
            <strong>系统 scope</strong>(offline_access/company.api)不参与用户权限收窄,不可删除。
          </p>
        </div>
        <CreateScopeDialog />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>name</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scopes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground py-8"
                >
                  暂无 scope(运行 seed 创建默认集合)
                </TableCell>
              </TableRow>
            ) : (
              scopes.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">
                      {s.name}
                    </code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.description ?? "—"}
                  </TableCell>
                  <TableCell>
                    {s.isSystem ? (
                      <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        系统
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">业务</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(s.createdAt).toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-right">
                    <ScopeActions id={s.id} isSystem={s.isSystem} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
