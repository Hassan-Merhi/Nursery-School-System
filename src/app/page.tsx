import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/security";

export default async function HomePage() {
  const auth = await getAuthContext();
  redirect(auth ? "/dashboard" : "/login");
}
