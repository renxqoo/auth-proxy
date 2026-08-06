"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { success, error as toastError } from "@/lib/toast";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      // 优先用现代 Clipboard API;HTTP / 非安全上下文下 navigator.clipboard 可能不存在
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // 回退到 execCommand,兼容非 HTTPS 环境
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("复制失败");
      }
      setCopied(true);
      success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toastError(e, "复制失败");
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={copy}
      title="复制完整令牌"
      aria-label="复制完整令牌"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
