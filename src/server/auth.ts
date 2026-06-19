import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const cookieName = "monitor_session";

export function registerAuth(app: FastifyInstance) {
  app.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { password?: string };
    const password = body.password ?? "";
    const hash = process.env.ADMIN_PASSWORD_HASH;

    const ok = hash ? await bcrypt.compare(password, hash) : password === "admin123";
    if (!ok) return reply.code(401).send({ error: "密码错误" });

    reply.setCookie(cookieName, signSession(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ authenticated: Boolean(readSession(request)) }));
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!readSession(request)) {
    return reply.code(401).send({ error: "未登录" });
  }
}

function signSession() {
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  const payload = Buffer.from(JSON.stringify({ iat: Date.now() })).toString("base64url");
  return `${payload}.${Buffer.from(`${payload}.${secret}`).toString("base64url")}`;
}

function readSession(request: FastifyRequest) {
  const token = request.cookies[cookieName];
  if (!token) return false;
  const [payload, signature] = token.split(".");
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  return signature === Buffer.from(`${payload}.${secret}`).toString("base64url");
}
