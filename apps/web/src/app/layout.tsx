import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayLens",
  description: "理解用户为什么没有完成订阅",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
