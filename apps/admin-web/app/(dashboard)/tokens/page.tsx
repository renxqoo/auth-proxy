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
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "./copy-button";
import { CreateTokenDialog } from "./create-dialog";
import { RevokeButton } from "./revoke-button";

interface TokenRow {
  id: number;
  token: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  singleUse: boolean;
  used: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

export default async function TokensPage() {
  const cookieStore = await cookies();
  const { tokens } = await serverGet<{ tokens: TokenRow[] }>(
    "/tokens",
    cookieStore.toString(),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">注册令牌</h1>
        <CreateTokenDialog />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>令牌</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>使用次数</TableHead>
              <TableHead>过期</TableHead>
              <TableHead>最后使用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="text-center text-muted-foreground py-8"
                >
                  暂无令牌,点击右上角创建
                </TableCell>
              </TableRow>
            ) : (
              tokens.map((t) => {
                const expired = new Date(t.expiresAt).getTime() <= Date.now();
                // 可吊销:有效(未吊销/未过期/未用完)
                const active = !t.revoked && !expired && !t.used;
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {t.token.slice(0, 16)}…
                        </code>
                        <CopyButton value={t.token} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {t.singleUse ? "一次性" : "多次"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {t.revoked ? (
                        <Badge variant="destructive">已吊销</Badge>
                      ) : t.used ? (
                        <Badge variant="secondary">已使用</Badge>
                      ) : expired ? (
                        <Badge variant="secondary">已过期</Badge>
                      ) : (
                        <Badge variant="success">有效</Badge>
                      )}
                    </TableCell>
                    <TableCell>{t.useCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(t.expiresAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {t.lastUsedAt
                        ? new Date(t.lastUsedAt).toLocaleString("zh-CN")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {active && <RevokeButton id={t.id} />}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
