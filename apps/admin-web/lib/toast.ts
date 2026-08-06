"use client";
import { toast } from "sonner";

/**
 * toast 封装 —— 区分成功/错误/警告。
 * 统一处理 API 错误消息(从 response body 提取 error_description)。
 */

/** 成功提示 */
export function success(message: string) {
  toast.success(message);
}

/** 错误提示(自动从 unknown 提取消息) */
export function error(err: unknown, fallback = "操作失败") {
  if (err instanceof Error) {
    toast.error(err.message);
    return;
  }
  // ApiError 格式:{ status, message }
  if (typeof err === "object" && err !== null && "message" in err) {
    toast.error(String((err as { message: unknown }).message));
    return;
  }
  toast.error(fallback);
}

/** 警告提示 */
export function warning(message: string) {
  toast.warning(message);
}

/** 信息提示 */
export function info(message: string) {
  toast.info(message);
}
