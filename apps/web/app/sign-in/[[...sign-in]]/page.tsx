import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { AuthFrame, tidelineAuthAppearance } from "../../auth-frame";

export default function SignInPage() {
  return (
    <AuthFrame>
      <Suspense>
        <SignIn appearance={tidelineAuthAppearance} fallbackRedirectUrl="/workspace" />
      </Suspense>
    </AuthFrame>
  );
}
