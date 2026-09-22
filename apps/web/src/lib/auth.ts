import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

export async function getSignedInUser() {
  if (!getSupabaseEnv()) {
    return null;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) {
    return null;
  }
  return { id: data.user.id, email: data.user.email };
}

export async function requireUser() {
  const user = await getSignedInUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
