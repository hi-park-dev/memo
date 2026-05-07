const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const NOTES_DIR = path.join(ROOT, "notes");

function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "")
    .replace(/\.+$/, "")
    .trim();
  return cleaned.slice(0, 80);
}

async function ensureNotesDir() {
  await fs.mkdir(NOTES_DIR, { recursive: true });
}

function isInsideNotes(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(path.resolve(NOTES_DIR) + path.sep);
}

function notePath(filename) {
  return path.join(NOTES_DIR, filename);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function uniqueFilename(base) {
  let candidate = `${base}.txt`;
  let i = 1;
  while (true) {
    try {
      await fs.access(notePath(candidate));
      i += 1;
      candidate = `${base} (${i}).txt`;
    } catch {
      return candidate;
    }
  }
}

async function listNotes() {
  await ensureNotesDir();
  const entries = await fs.readdir(NOTES_DIR);
  const txts = entries.filter((f) => f.endsWith(".txt"));
  const items = await Promise.all(
    txts.map(async (filename) => {
      const full = notePath(filename);
      const [stat, content] = await Promise.all([
        fs.stat(full),
        fs.readFile(full, "utf8"),
      ]);
      return {
        filename,
        title: filename.replace(/\.txt$/, ""),
        content,
        createdAt: stat.birthtimeMs || stat.ctimeMs,
        updatedAt: stat.mtimeMs,
      };
    })
  );
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

async function createNote({ title, content }) {
  await ensureNotesDir();
  const safe = sanitizeFilename(title || "");
  const base = safe || `untitled-${Date.now()}`;
  const filename = await uniqueFilename(base);
  await fs.writeFile(notePath(filename), content ?? "", "utf8");
  return filename;
}

async function updateNote(filename, { title, content }) {
  const oldPath = notePath(filename);
  if (!isInsideNotes(oldPath)) throw new Error("invalid path");

  let newFilename = filename;
  const desiredBase = sanitizeFilename(title || "") || `untitled-${Date.now()}`;
  const desired = `${desiredBase}.txt`;

  if (desired !== filename) {
    newFilename = await uniqueFilename(desiredBase);
    await fs.rename(oldPath, notePath(newFilename));
  }
  await fs.writeFile(notePath(newFilename), content ?? "", "utf8");
  return newFilename;
}

async function deleteNote(filename) {
  const p = notePath(filename);
  if (!isInsideNotes(p)) throw new Error("invalid path");
  await fs.unlink(p);
}

async function serveStatic(res, filePath, contentType) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  try {
    if (method === "GET" && pathname === "/") {
      return serveStatic(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
    }

    if (method === "GET" && pathname === "/api/memos") {
      const items = await listNotes();
      return send(res, 200, items);
    }

    if (method === "POST" && pathname === "/api/memos") {
      const body = await readBody(req);
      const title = (body.title || "").toString();
      const content = (body.content || "").toString();
      if (!title.trim() && !content.trim()) {
        return send(res, 400, { error: "title or content required" });
      }
      const filename = await createNote({ title, content });
      return send(res, 201, { filename });
    }

    const match = pathname.match(/^\/api\/memos\/(.+)$/);
    if (match) {
      const filename = decodeURIComponent(match[1]);
      if (!filename.endsWith(".txt") || filename.includes("/") || filename.includes("\\")) {
        return send(res, 400, { error: "invalid filename" });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const title = (body.title || "").toString();
        const content = (body.content || "").toString();
        const newFilename = await updateNote(filename, { title, content });
        return send(res, 200, { filename: newFilename });
      }
      if (method === "DELETE") {
        await deleteNote(filename);
        return send(res, 204, "");
      }
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`메모장 서버 실행 중: http://localhost:${PORT}`);
  console.log(`메모 저장 위치: ${NOTES_DIR}`);
});
