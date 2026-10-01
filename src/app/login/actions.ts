"use server";

import { redirect } from "next/navigation";
import { authenticate, createSession } from "@/lib/security";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    redirect("/login?error=Enter%20your%20email%20and%20password.");
  }

  const result = await authenticate(email, password);
  if (!result.ok) {
    redirect("/login?error=Unable%20to%20sign%20in.%20Check%20your%20credentials%20or%20try%20again%20later.");
  }

  await createSession(result.userId);
  redirect("/dashboard");
}
