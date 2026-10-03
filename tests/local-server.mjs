import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const port = Number(process.argv[2] || 43119);
const root = path.resolve(process.argv[3] || "dist");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
    const filePath = path.resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const body = await fs.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local test server: http://127.0.0.1:${port}/`);
});
