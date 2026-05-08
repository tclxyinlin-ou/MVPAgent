import type { Metadata } from "next";
import "@toast-ui/editor/dist/toastui-editor.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "文档问答 MVP",
  description: "根据上传文档进行检索问答的最小可用版本",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
