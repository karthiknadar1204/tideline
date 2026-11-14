import type { NextConfig } from "next";

const config: NextConfig = {
  logging: { incomingRequests: { ignore: [/[?&]query=/, /%3Fquery%3D|%26query%3D/i] } },
};

export default config;
