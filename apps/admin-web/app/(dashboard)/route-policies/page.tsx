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
import { CreateRoutePolicyDialog } from "./create-dialog";
import { RoutePolicyActions } from "./route-policy-actions";

interface RoutePolicyRow {
  id: number;
  pattern: string;
  scope: string | null;
  method: string | null;
  description: string | null;
  createdAt: string;
}

export default async function RoutePoliciesPage() {
  const cookieStore = await cookies();
  const { policies } = await serverGet<{ policies: RoutePolicyRow[] }>(
    "/route-policies",
    cookieStore.toString(),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">路径策略</h1>
          <p className="text-sm text-muted-foreground mt-1">
            gateway 转发前的 scope 校验(层 4)。<strong>默认拒绝</strong>:
            没配策略的路径直接 403。pattern 用通配符(/api/orders* 匹配子路径)。
            scope 留空 = 只需登录。
          </p>
        </div>
        <CreateRoutePolicyDialog />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>pattern</TableHead>
              <TableHead>scope</TableHead>
              <TableHead>method</TableHead>
              <TableHead>说明</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground py-8"
                >
                  暂无策略 ⚠️ 默认拒绝下所有路径都会 403,请先配策略
                </TableCell>
              </TableRow>
            ) : (
              policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">
                      {p.pattern}
                    </code>
                  </TableCell>
                  <TableCell>
                    {p.scope ? (
                      <code className="text-sm font-mono">{p.scope}</code>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        只需登录
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.method ?? <span className="text-muted-foreground">全部</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <RoutePolicyActions id={p.id} />
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
