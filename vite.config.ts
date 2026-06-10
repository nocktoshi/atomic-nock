import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const upstream =
    env.VITE_NOCK_GRPC_UPSTREAM ?? "https://rpc.nockchain.net";

  return {
    server: {
      port: 5173,
      historyApiFallback: true,
      proxy: {
        "/nockchain.public.v2.NockchainService": {
          target: upstream,
          changeOrigin: true,
          secure: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("origin", "https://rpc.nockchain.net");
              proxyReq.setHeader("referer", "https://rpc.nockchain.net/");
            });
          },
        },
        "/nockchain.private.v1": {
          target: upstream,
          changeOrigin: true,
          secure: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("origin", "https://rpc.nockchain.net");
              proxyReq.setHeader("referer", "https://rpc.nockchain.net/");
            });
          },
        },
      },
    },
    optimizeDeps: {
      exclude: ["@nockbox/iris-wasm", "@nockchain/rose-wasm"],
    },
    plugins: [
      react(),
      {
        name: "wasm-mime",
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.includes(".wasm")) {
              res.setHeader("Content-Type", "application/wasm");
            }
            next();
          });
        },
      },
    ],
  };
});