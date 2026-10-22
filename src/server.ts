import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { lerImagem } from "./midia.js";

function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function ocultarToken(url: string): string {
  return url.replace(/^\/(webhook|painel|midia)\/[^/?#]+/, "/$1/***");
}

export interface OpcoesPainel {
  token: string;
  pagina(base: string): Promise<string>;
  acao(campos: Record<string, string>): Promise<void>;
}

/**
 * O webhook responde 200 na hora e processa depois: o engine espera pouco, e um
 * evento lento (áudio, comando que chama o Claude) não pode segurar os seguintes.
 * O painel só existe com PAINEL_TOKEN.
 */
export function criarServidor(opts: {
  webhookToken: string;
  aoEvento(payload: unknown): Promise<unknown>;
  painel?: OpcoesPainel;
}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // O token do webhook e o do painel vão no caminho: não podem aparecer no log.
      serializers: {
        req: (req) => ({ method: req.method, url: ocultarToken(req.url) }),
      },
    },
    // O histórico do pareamento chega em eventos grandes.
    bodyLimit: 100 * 1024 * 1024,
  });
  // Formulário do painel, sem dependência a mais.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, corpo, feito) => {
    feito(null, Object.fromEntries(new URLSearchParams(String(corpo))));
  });

  app.get("/saude", async () => ({ ok: true }));

  // O cartão do resumo, buscado pela Evolution na hora do envio (ver midia.ts).
  app.get<{ Params: { id: string } }>("/midia/:id", async (req, reply) => {
    const png = lerImagem(req.params.id.replace(/\.png$/, ""));
    if (!png) return reply.code(404).send();
    return reply.header("Cache-Control", "no-store").type("image/png").send(png);
  });

  app.post<{ Params: { token: string } }>("/webhook/:token", async (req, reply) => {
    if (!tokenConfere(req.params.token, opts.webhookToken)) return reply.code(401).send({ error: "unauthorized" });
    const payload = req.body;
    setImmediate(() => {
      opts.aoEvento(payload).catch((err) => req.log.error({ err: String(err) }, "evento falhou"));
    });
    return { ok: true };
  });

  const painel = opts.painel;
  if (painel) {
    app.get<{ Params: { token: string } }>("/painel/:token", async (req, reply) => {
      if (!tokenConfere(req.params.token, painel.token)) return reply.code(404).send();
      reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex").type("text/html; charset=utf-8");
      return painel.pagina(`/painel/${req.params.token}`);
    });
    app.post<{ Params: { token: string }; Body: Record<string, string> }>("/painel/:token/acao", async (req, reply) => {
      if (!tokenConfere(req.params.token, painel.token)) return reply.code(404).send();
      await painel.acao(req.body ?? {});
      // Volta para a página: recarregar não repete a ação.
      return reply.redirect(`/painel/${req.params.token}`, 303);
    });
  }

  return app;
}
