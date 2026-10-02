"use server";

import { redirect } from "next/navigation";
import { authenticate, createSession } from "@/lib/security";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    redirect("/login?error=Enter%20your%20email%20and%20password.");
  }

  let result;
  try {
    result = await authenticate(email, password);
  } catch (error) {
    console.error("Authentication request failed", error);
    redirect("/login?error=Sign-in%20is%20temporarily%20unavailable.%20Please%20try%20again.");
  }

  if (!result.ok) {
    redirect("/login?error=Unable%20to%20sign%20in.%20Check%20your%20credentials%20or%20try%20again%20later.");
  }

  try {
    await createSession(result.userId);
  } catch (error) {
    console.error("Session creation failed", error);
    redirect("/login?error=Your%20password%20was%20accepted%2C%20but%20the%20session%20could%20not%20be%20created.%20Please%20try%20again.");
  }

  redirect("/dashboard");
}
