/**
 * Mock 业务假数据 —— 模拟公司应用的订单/商品/发票库。
 *
 * 设计要点:
 * - 全部硬编码、按 userId 分桶,方便测"数据可见性"边界(谁能看哪些订单)。
 * - 字段尽量贴近真实业务形态(货币、状态机、行项目),让 gateway 透传后的
 *   JSON 像样,而非占位符。
 * - 订单列表是订单详情的投影;详情含行项目,二者 id 对齐,避免接口间矛盾。
 */

export interface OrderLineItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderSummary {
  id: string;
  userId: string;
  status: "pending" | "paid" | "shipped" | "cancelled";
  total: number;
  currency: "CNY" | "USD";
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  items: OrderLineItem[];
  shippingAddress: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  price: number;
  currency: "CNY" | "USD";
  stock: number;
}

export interface Invoice {
  id: string;
  orderId: string;
  userId: string;
  amount: number;
  currency: "CNY" | "USD";
  status: "issued" | "paid" | "void";
  issuedAt: string;
}

// ---------- 商品目录 ----------
export const PRODUCTS: Product[] = [
  {
    id: "p_001",
    sku: "SKU-MUG-RED",
    name: "红色马克杯",
    category: "厨房用品",
    price: 39.0,
    currency: "CNY",
    stock: 320,
  },
  {
    id: "p_002",
    sku: "SKU-KEY-K1",
    name: "机械键盘 K1",
    category: "电脑外设",
    price: 599.0,
    currency: "CNY",
    stock: 48,
  },
  {
    id: "p_003",
    sku: "SKU-MOUSE-M2",
    name: "无线鼠标 M2",
    category: "电脑外设",
    price: 159.0,
    currency: "CNY",
    stock: 200,
  },
  {
    id: "p_004",
    sku: "SKU-NOTE-A5",
    name: "A5 笔记本",
    category: "文具",
    price: 25.5,
    currency: "CNY",
    stock: 1500,
  },
  {
    id: "p_005",
    sku: "SKU-CABLE-USBC",
    name: "USB-C 数据线 1.5m",
    category: "配件",
    price: 49.0,
    currency: "CNY",
    stock: 0, // 缺货,测边界
  },
];

// ---------- 订单(列表视图) ----------
export const ORDER_SUMMARIES: OrderSummary[] = [
  {
    id: "o_1001",
    userId: "u_alice",
    status: "paid",
    total: 199.0,
    currency: "CNY",
    createdAt: "2024-02-10T03:15:00Z",
  },
  {
    id: "o_1002",
    userId: "u_alice",
    status: "shipped",
    total: 58.5,
    currency: "CNY",
    createdAt: "2024-03-01T11:40:00Z",
  },
  {
    id: "o_1003",
    userId: "u_carol",
    status: "pending",
    total: 599.0,
    currency: "CNY",
    createdAt: "2024-04-12T07:20:00Z",
  },
  {
    id: "o_1004",
    userId: "u_carol",
    status: "cancelled",
    total: 159.0,
    currency: "CNY",
    createdAt: "2024-04-18T09:05:00Z",
  },
  {
    id: "o_1005",
    userId: "u_dave",
    status: "paid",
    total: 49.0,
    currency: "CNY",
    createdAt: "2024-05-02T14:00:00Z",
  },
];

// ---------- 订单(详情视图,带行项目) ----------
export const ORDER_DETAILS: OrderDetail[] = [
  {
    ...ORDER_SUMMARIES[0],
    items: [
      { productId: "p_001", name: "红色马克杯", quantity: 3, unitPrice: 39.0 },
      { productId: "p_004", name: "A5 笔记本", quantity: 2, unitPrice: 25.5 },
    ],
    shippingAddress: "北京市朝阳区示例路 1 号",
  },
  {
    ...ORDER_SUMMARIES[1],
    items: [{ productId: "p_001", name: "红色马克杯", quantity: 1, unitPrice: 39.0 }],
    shippingAddress: "北京市朝阳区示例路 1 号",
  },
  {
    ...ORDER_SUMMARIES[2],
    items: [{ productId: "p_002", name: "机械键盘 K1", quantity: 1, unitPrice: 599.0 }],
    shippingAddress: "上海市浦东新区示例大道 88 号",
  },
  {
    ...ORDER_SUMMARIES[3],
    items: [{ productId: "p_003", name: "无线鼠标 M2", quantity: 1, unitPrice: 159.0 }],
    shippingAddress: "上海市浦东新区示例大道 88 号",
  },
  {
    ...ORDER_SUMMARIES[4],
    items: [{ productId: "p_005", name: "USB-C 数据线 1.5m", quantity: 1, unitPrice: 49.0 }],
    shippingAddress: "深圳市南山区示例科技园 6 栋",
  },
];

// ---------- 发票 ----------
export const INVOICES: Invoice[] = [
  {
    id: "inv_2001",
    orderId: "o_1001",
    userId: "u_alice",
    amount: 199.0,
    currency: "CNY",
    status: "paid",
    issuedAt: "2024-02-10T03:20:00Z",
  },
  {
    id: "inv_2002",
    orderId: "o_1005",
    userId: "u_dave",
    amount: 49.0,
    currency: "CNY",
    status: "issued",
    issuedAt: "2024-05-02T14:05:00Z",
  },
];

// ---------- 查询 helper(数据可见性按 userId 隔离) ----------
export function ordersByUser(userId: string): OrderSummary[] {
  return ORDER_SUMMARIES.filter((o) => o.userId === userId);
}

export function orderDetail(userId: string, orderId: string): OrderDetail | null {
  const d = ORDER_DETAILS.find((o) => o.id === orderId);
  // 跨用户访问订单 → 视为不存在(404),不暴露"该订单属于别人"
  if (!d || d.userId !== userId) return null;
  return d;
}

export function invoicesByUser(userId: string): Invoice[] {
  return INVOICES.filter((i) => i.userId === userId);
}

export function productById(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
