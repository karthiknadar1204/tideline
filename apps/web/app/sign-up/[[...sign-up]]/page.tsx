import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";
import { AuthFrame, tidelineAuthAppearance } from "../../auth-frame";

export default function SignUpPage() {
  return (
    <AuthFrame>
      <Suspense>
        <SignUp appearance={tidelineAuthAppearance} fallbackRedirectUrl="/workspace" />
      </Suspense>
    </AuthFrame>
  );
}
