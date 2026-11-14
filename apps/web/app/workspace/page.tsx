import { redirect } from "next/navigation";
import { requestWorkspace } from "../../lib/workspace";

export default async function PersonalWorkspace() {
  const workspace = await requestWorkspace("personal", "POST");
  redirect(`/workspace/${workspace.id}`);
}
