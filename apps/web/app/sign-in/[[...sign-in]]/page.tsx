import { Suspense } from "react";
import { AuthFrame } from "../../auth-frame";
import { WorkspaceSignIn } from "../workspace-sign-in";

export default function SignInPage() {
  return (
    <AuthFrame>
      <Suspense>
        <WorkspaceSignIn origin={new URL(process.env.TIDELINE_WEB_ORIGIN ?? "http://localhost:3000").origin} />
      </Suspense>
    </AuthFrame>
  );
}
