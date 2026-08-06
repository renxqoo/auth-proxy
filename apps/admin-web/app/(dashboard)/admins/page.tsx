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
import { CreateAdminDialog } from "./create-dialog";
import { DeleteAdminButton } from "./delete-button";

interface AdminRow {
  id: number;
  username: string;
  createdAt: string;
}

export default async function AdminsPage() {
  const cookieStore = await cookies();
  const me = await serverGet<{ id: number; username: string }>(
    "/me",
    cookieStore.toString(),
  );
  const { admins } = await serverGet<{ admins: AdminRow[] }>(
    "/admins",
    cookieStore.toString(),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">管理员</h1>
          <p className="text-sm text-muted-foreground mt-1">
            当前登录:{me.username}
          </p>
        </div>
        <CreateAdminDialog />
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户名</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  {a.username}
                  {a.id === me.id && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      (你)
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="text-right">
                  {a.id === me.id ? (
                    <span className="text-xs text-muted-foreground">
                      不能删除自己
                    </span>
                  ) : (
                    <DeleteAdminButton id={a.id} />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
