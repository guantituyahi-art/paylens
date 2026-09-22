"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    setPending(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    setMessage("登录链接已发送。请打开邮箱中的邮件完成登录。");
  }

  return (
    <form onSubmit={onSubmit}>
      <label>
        邮箱
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "发送中…" : "发送登录链接"}
      </button>
      {message ? <p className="banner">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
