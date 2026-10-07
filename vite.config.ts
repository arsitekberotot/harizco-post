// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Harizco Post: client build. React Router SPA mode — no Workers plugin, no
// SSR runtime, no cloud bindings. The Node runtime (server/index.ts) serves
// dist/client plus the API on loopback.
export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  plugins: [
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
});
