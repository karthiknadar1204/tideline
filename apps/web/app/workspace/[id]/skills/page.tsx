import { ActivityPage } from "../dashboard/activity-page";

export default async function SkillsPage({ params, searchParams }: PageProps<"/workspace/[id]/skills">) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <ActivityPage workspaceId={id} kind="skills" query={query} />;
}
