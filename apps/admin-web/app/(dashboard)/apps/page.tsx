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
import { AppActions } from "./app-actions";

interface AppRow {
  id: number;
  clientId: string;
  name: string;
  createdAt: string;
  createdFromTokenId: number | null;
  lastUsedAt: string | null;
}

export default async function AppsPage() {
  const cookieStore = await cookies();
  const { apps } = await serverGet<{ apps: AppRow[] }>(
    "/apps",
    cookieStore.toString(),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">客户端</h1>
        <p className="text-sm text-muted-foreground mt-1">
          每台机器注册 CLI 时创建的独立 client。
          <strong>踢下线</strong>会使其会话失效(需重新登录,client 仍可用);
          <strong>删除</strong>则彻底作废(需重新 register)。
        </p>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>clientId</TableHead>
              <TableHead>来源令牌</TableHead>
              <TableHead>最后使用</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  暂无客户端(CLI 注册后会出现在这里)
                </TableCell>
              </TableRow>
            ) : (
              apps.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {a.clientId}
                    </code>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.createdFromTokenId ? `#${a.createdFromTokenId}` : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lastUsedAt
                      ? new Date(a.lastUsedAt).toLocaleString("zh-CN")
                      : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="text-right">
                    <AppActions id={a.id} />
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
