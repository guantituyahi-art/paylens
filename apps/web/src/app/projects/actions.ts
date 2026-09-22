"use server";

import { redirect } from "next/navigation";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import {
  createProjectForDeveloper,
  ensureDeveloperRecord,
  ProjectInputError,
} from "@/lib/projects";
import { createClient } from "@/lib/supabase/server";

export async function createProjectAction(formData: FormData) {
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    redirect("/projects?error=database");
  }
  const name = String(formData.get("name") ?? "");
  const timezone = String(formData.get("timezone") ?? "");
  try {
    const db = getDb();
    await ensureDeveloperRecord(db, developer);
    await createProjectForDeveloper(db, developer.id, { name, timezone });
  } catch (error) {
    if (error instanceof ProjectInputError) {
      const code = error.message.includes("时区") ? "timezone" : "name";
      redirect(`/projects?error=${code}`);
    }
    throw error;
  }
  redirect("/projects?created=1");
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
