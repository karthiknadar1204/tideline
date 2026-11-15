import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { fetchTidelineApi } from "../../../lib/workspace";

export async function requestAccountDeletion(options: RequestInit = {}) {
  const { getToken } = await auth.protect();
  const token = await getToken();
  if (!token) redirect("/sign-in");
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetchTidelineApi("/account/deletion", { ...options, headers });
  if (response?.status === 401) redirect("/sign-in");
  return response;
}
