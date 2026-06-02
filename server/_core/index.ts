import "./loadEnv";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { createProxyMiddleware } from "http-proxy-middleware";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.use((req, res, next) => {
    console.log("START", req.originalUrl);

    res.on("finish", () => {
      console.log("END", req.originalUrl, res.statusCode);
    });

    next();
  });

  // tRPC API
  app.use(
    "/im-agents/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  app.use(
    "/im-agents/api",
    createProxyMiddleware({
      target: "http://localhost:5173",
      changeOrigin: true,
      pathRewrite: {
        "^/im-agents": "",
      },
    })
  );

  app.use(
    "/im-agents/design",
    createProxyMiddleware({
      target: "http://localhost:5173",
      timeout: 600000,       // time for incoming request (client → proxy)
      proxyTimeout: 600000,
      changeOrigin: true,
      pathRewrite: {
        "^/im-agents": "",
      },
    })
  );

  app.use(
    createProxyMiddleware({
      target: "http://localhost:3005",
      changeOrigin: true,
      timeout: 600000,       // time for incoming request (client → proxy)
      proxyTimeout: 600000,
      pathFilter: (pathname) =>
        pathname.startsWith("/im-agents/varnish"),
      pathRewrite: (path, req) => {
        return "originalUrl" in req && typeof req.originalUrl === "string"
          ? req.originalUrl
          : path;
      },
    })
  );

  // Do not mount on /im-agents/regression-testing (Express would strip it from req.url).
  // Forward originalUrl unchanged so :3010 receives /im-agents/regression-testing/...
  app.use(
    createProxyMiddleware({
      target: "http://localhost:3010",
      changeOrigin: true,
      timeout: 600000,       // time for incoming request (client → proxy)
      proxyTimeout: 600000,
      pathFilter: (pathname) =>
        pathname.startsWith("/im-agents/regression-testing"),
      pathRewrite: (path, req) => {
        return "originalUrl" in req && typeof req.originalUrl === "string"
          ? req.originalUrl
          : path;
      },
    })
  );

  app.use(
    createProxyMiddleware({
      target: "http://localhost:3002",
      changeOrigin: true,
      timeout: 600000,       // time for incoming request (client → proxy)
      proxyTimeout: 600000,
      pathFilter: (pathname) =>
        pathname.startsWith("/im-agents/pii_agent"),
      pathRewrite: (path, req) => {
        return "originalUrl" in req && typeof req.originalUrl === "string"
          ? req.originalUrl
          : path;
      },
    })
  );


  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
