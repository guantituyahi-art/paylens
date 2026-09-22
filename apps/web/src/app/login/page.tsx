import { redirect } from "next/navigation";
import { LoginForm } from "@/app/login/login-form";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const env = getSupabaseEnv();
  if (env) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      redirect("/projects");
    }
  }

  return (
    <main>
      <h1>登录 PayLens</h1>
      <p>使用邮箱接收登录链接。没有密码。</p>
      {env ? null : (
        <p className="error">
          还没有配置 Supabase。请把 apps/web/.env.example 复制为 apps/web/.env.local，填入
          NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY。
        </p>
      )}
      {params.error ? <p className="error">登录链接无效或已过期，请重新发送。</p> : null}
      {env ? <LoginForm /> : null}
    </main>
  );
}
