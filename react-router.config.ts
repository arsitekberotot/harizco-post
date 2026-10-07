// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Config } from "@react-router/dev/config";

// Harizco Post: single-page application build. The Node runtime
// (server/index.ts) serves dist/client and the API on loopback.
export default {
  ssr: false,
  buildDirectory: "dist",
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
