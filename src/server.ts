import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Só duas rotas. O webhook responde 200 na hora e processa depois: o engine espera
 * pouco, e um evento lento (áudio, comando que chama o Claude) não pode segurar os
 * seguintes.
 */
export function criarServidor(opts: {
  webhookToken: string;
  aoEvento(payload: unknown): Promise<unknown>;
}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 25 * 1024 * 1024 });

  app.get("/saude", async () => ({ ok: true }));

  app.post<{ Params: { token: string } }>("/webhook/:token", async (req, reply) => {
    if (!tokenConfere(req.params.token, opts.webhookToken)) return reply.code(401).send({ error: "unauthorized" });
    const payload = req.body;
    setImmediate(() => {
      opts.aoEvento(payload).catch((err) => req.log.error({ err: String(err) }, "evento falhou"));
    });
    return { ok: true };
  });

  return app;
}
