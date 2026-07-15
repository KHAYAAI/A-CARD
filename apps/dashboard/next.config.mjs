/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_ACARD_API_URL: process.env.NEXT_PUBLIC_ACARD_API_URL ?? "http://localhost:8787",
  },
};

export default nextConfig;
