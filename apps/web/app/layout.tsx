import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { themeScript } from "../lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tideline",
  description: "See what your coding agents did.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        <ClerkProvider signInUrl="/sign-in" signUpUrl="/sign-up"
          appearance={{ userProfile: { elements: { profileSection__danger: { display: "none" } } } }}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
