import "./setup.ts";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Handler, MiddlewareHandler, Next } from "hono";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Child } from "hono/jsx";
import { type FC } from "hono/jsx";
import { renderToReadableStream } from "hono/jsx/streaming";
import { hasStatic, root } from "hydrogen/util.ts";
import { readdir, stat } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { HtmlContext } from "./context.ts";
import { environment } from "./environment.ts";
import { getLogger, loggerMiddleware, setLoggerMetadata } from "./logger.ts";
import { watchCss } from "./css.ts";

let config = {
  pageDir: "pages",
  functionDir: "functions",
};

function setConfig(customConfig: Partial<typeof config>) {
  const newConfig: any = { ...config };
  for (const [key, value] of Object.entries(customConfig)) {
    if (value) {
      newConfig[key] = value;
    }
  }
  config = newConfig;
}

type AppHandler = (app: Hono) => void | Promise<void>;
const noop = () => void 0;

interface StartConfig {
  name?: string;
  port?: number;
  hot?: boolean;
  pageDir?: string;
  functionDir?: string;
  beforeRoutes?: AppHandler;
  afterRoutes?: AppHandler;
}

export async function start({
  name = "app",
  port,
  hot = environment.WATCH,
  pageDir,
  functionDir,
  beforeRoutes = noop,
  afterRoutes = noop,
}: StartConfig = {}) {
  watchCss();

  setConfig({
    pageDir,
    functionDir,
  });

  setLoggerMetadata("service", name);

  const app = await setupHono(beforeRoutes, afterRoutes);

  const server = serve({
    hostname: "0.0.0.0",
    port: port ?? environment.PORT,
    fetch: app.fetch,
  }) as Server;

  console.info(`🚀 http://localhost:${port ?? environment.PORT}`);

  if (hot) {
    import("./hot-reload.ts").then(({ setupHotReload }) =>
      setupHotReload(server),
    );
  }

  return { app, server, config };
}

const notFoundHandler = (c: Context) => {
  return c.text("not found", 404);
};

const errorHandler = (error: Error, c: Context) => {
  getLogger().error(error, error.message);

  return c.json(
    {
      message: error.message || "unexpected error",
      ...(environment.WATCH && { stack: error.stack }),
    },
    (error as any).statusCode ?? 500,
  );
};

async function setupHono(
  beforeRoutes: AppHandler = noop,
  afterRoutes: AppHandler = noop,
) {
  const app = new Hono();

  app.use("*", loggerMiddleware);

  if (hasStatic) {
    app.use(
      "/static/*",
      (c, next) => {
        if (!environment.WATCH) {
          c.header(
            "Cache-Control",
            "public, max-age=31536000, s-maxage=31536000",
          );
        }

        return next();
      },
      serveStatic({ root: "./" }),
    );
  }

  app.notFound(notFoundHandler);

  app.onError(errorHandler);

  app.get("/health", (c) => c.text("ok"));

  app.post("/sentinel", async (c) => {
    const payload = await c.req.json();
    payload.url = c.req.url;
    getLogger().info(payload, "🛡️ sentinel");

    return c.body(null, 200);
  });

  await beforeRoutes(app);

  await generateFunctions(app);

  await generatePages(app);

  await afterRoutes(app);

  return app;
}

async function generateFunctions(app: Hono) {
  const functions = await generate(config.functionDir, [".ts", ".tsx"]);

  for (const { route, getModule } of functions) {
    app.all(path.join("api", route), async (c, next) => {
      const module = await getModule();
      const {
        default: handler,
        method = "get",
        middlewares = [],
      } = module as {
        method: "get" | "post" | "put" | "delete";
        middlewares: MiddlewareHandler[];
        default: Handler;
      };

      if (method !== c.req.method.toLowerCase()) {
        return c.notFound();
      }

      return compose(c, next, ...middlewares, handler);
    });
  }
}

async function generatePages(app: Hono) {
  const pages = await generate(config.pageDir, [".ts", ".tsx", ".mdx"]);

  for (const { route, importPath, getModule } of pages) {
    const resolvedRoute = route === "/home" ? "/" : route;

    app.all(resolvedRoute, async (c, next) => {
      const module = await getModule();

      const page = module as {
        method: "get" | "post" | "put" | "delete";
        middlewares: MiddlewareHandler[];
        default: FC;
        config?: {
          layout?: FC;
          title?: string;
          description?: string;
          keywords?: string;
          publishedAt?: string;
        };
      };

      const method = page.method ?? "get";

      if (method !== c.req.method.toLowerCase()) {
        return c.notFound();
      }

      const middlewares = page.middlewares ?? [];
      const Layout =
        page.config?.layout ??
        ((({ children }) => <>{children}</>) satisfies FC);

      const handler: Handler = (c) =>
        render(
          c,
          <HtmlContext.Provider
            value={{
              c,
              route: resolvedRoute,
              name: path.basename(importPath),
              title: page.config?.title ?? "",
              description: page.config?.description ?? "",
              keywords: page.config?.keywords ?? "",
              publishedAt: page.config?.publishedAt ?? "",
            }}
          >
            <Layout>
              <page.default />
            </Layout>
          </HtmlContext.Provider>,
        );

      return compose(c, next, ...middlewares, handler);
    });
  }
}

async function generate(directory: string, extensions: string[]) {
  const directoryPath = path.join(root, directory);
  const existDirectory = await stat(directoryPath).then(
    () => true,
    () => false,
  );

  if (!existDirectory) {
    return [];
  }

  let entries = await readdir(path.join(root, directory), {
    recursive: true,
    withFileTypes: true,
  });
  entries = entries
    .filter((entry) => !entry.name.startsWith("_"))
    .filter((entry) => !entry.isDirectory())
    .filter((entry) => extensions.includes(path.extname(entry.name)))
    .toSorted((a) => (a.name.includes(":") ? 1 : -1));

  return Promise.all(
    entries.map((entry) => {
      const route = path
        .join(path.relative(root, entry.path), entry.name)
        .replace(directory, "")
        .replace(path.extname(entry.name), "");
      const importPath = path.join(
        root,
        path.relative(root, entry.path),
        entry.name,
      );

      return { route, importPath, getModule: () => import(importPath) };
    }),
  );
}

function render(c: Context, content: Child) {
  const body = html`${raw("<!DOCTYPE html>")}${content}`;

  return c.body(renderToReadableStream(body), {
    headers: {
      "Transfer-Encoding": "chunked",
      "Content-Type": "text/html; charset=UTF-8",
    },
  });
}

async function compose(
  c: Context,
  next: Next,
  ...handlers: MiddlewareHandler[]
) {
  const [handler, ...rest] = handlers;

  try {
    const response = await handler(c, () => compose(c, next, ...rest) as any);

    if (response) {
      return response;
    }
  } catch (error) {
    return errorHandler(error as Error, c);
  }

  return notFoundHandler(c);
}
