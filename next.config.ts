import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  async headers() {
    return [{
      source: "/",
      headers: [{ key: "Content-Security-Policy", value: "frame-src 'none'" }],
    }];
  },
};

export default nextConfig;
