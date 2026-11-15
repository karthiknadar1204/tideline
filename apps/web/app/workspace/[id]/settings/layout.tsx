import { readWorkspaceAccess } from "../../../../lib/workspace";
import { SettingsHeader } from "./settings-header";

export default async function WorkspaceSettingsLayout({ params, children }: LayoutProps<"/workspace/[id]/settings">) {
  const { id } = await params;
  const workspace = await readWorkspaceAccess(id);

  return (
    <div className="space-y-6 pt-7 sm:pt-9">
      <SettingsHeader workspace={workspace} />
      {children}
    </div>
  );
}
