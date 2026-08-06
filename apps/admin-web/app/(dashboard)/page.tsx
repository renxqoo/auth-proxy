import { cookies } from "next/headers";
import { serverGet } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Overview {
  tokens: { total: number; active: number };
  apps: { total: number; active: number };
}

export default async function OverviewPage() {
  const cookieStore = await cookies();
  const data = await serverGet<Overview>("/overview", cookieStore.toString());

  const stats = [
    {
      label: "注册令牌",
      total: data.tokens.total,
      active: data.tokens.active,
      activeLabel: "有效",
    },
    {
      label: "客户端",
      total: data.apps.total,
      active: data.apps.active,
      activeLabel: "活跃",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">概览</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{s.total}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {s.active} {s.activeLabel}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
