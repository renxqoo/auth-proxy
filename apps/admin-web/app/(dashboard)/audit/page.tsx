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

interface LoginLog {
  id: number;
  sessionId: string | null;
  userCode: string;
  username: string;
  clientId: string;
  success: boolean;
  ip: string | null;
  createdAt: string;
}
interface ApiLog {
  id: number;
  sessionId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  createdAt: string;
}

export default async function AuditPage() {
  const cookieStore = await cookies();
  const cookie = cookieStore.toString();
  const [{ logs: loginLogs }, { logs: apiLogs }] = await Promise.all([
    serverGet<{ logs: LoginLog[] }>("/audit/login?limit=50", cookie),
    serverGet<{ logs: ApiLog[] }>("/audit/api?limit=50", cookie),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">审计日志</h1>
        <p className="text-sm text-muted-foreground mt-1">最近 50 条</p>
      </div>

      <section>
        <h2 className="text-lg font-medium mb-3">登录记录</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>客户端</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loginLogs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground py-6"
                  >
                    暂无记录(CLI 用户登录后会出现)
                  </TableCell>
                </TableRow>
              ) : (
                loginLogs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(l.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell className="font-medium">
                      {l.username.startsWith("[REUSE]") ? (
                        <Badge variant="destructive">{l.username}</Badge>
                      ) : (
                        l.username
                      )}
                    </TableCell>
                    <TableCell>
                      {l.success ? (
                        <Badge variant="success">成功</Badge>
                      ) : (
                        <Badge variant="destructive">失败</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{l.ip ?? "—"}</TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {l.clientId.slice(0, 16)}…
                      </code>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-medium mb-3">API 调用记录</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>路径</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiLogs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground py-6"
                  >
                    暂无记录(经 gateway 调接口后会出现)
                  </TableCell>
                </TableRow>
              ) : (
                apiLogs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(l.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{l.method}</Badge>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{l.path}</code>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={l.status < 400 ? "success" : "destructive"}
                      >
                        {l.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{l.durationMs}ms</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
