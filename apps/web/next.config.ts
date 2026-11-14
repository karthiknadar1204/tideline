import type { NextConfig } from "next";

const config: NextConfig = {
  logging: { incomingRequests: { ignore: [/[?&]query=/, /%3Fquery%3D|%26query%3D/i, /\/(?:invite|share)\//, /%2F(?:invite|share)%2F/i] } },
  async headers() {
    return [{
      source: "/:page(invite|share|sign-in|sign-up)/:path*",
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }];
  },
};

export default config;
