import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { tratarMcp, type DepsMcp } from "./mcp.js";
import { lerImagem } from "./midia.js";
import { voltaSegura } from "./painel.js";

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
  /** `aviso`: o resultado da última ação, mostrado uma vez no alto. `consulta`: aba e item abertos. */
  pagina(base: string, aviso: string, consulta: Record<string, string>): Promise<string>;
  acao(campos: Record<string, string>): Promise<string | void>;
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
  mcp?: { token: string } & DepsMcp;
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
    // Um dono só: o resultado da última ação fica aqui até a página recarregar. Na URL,
    // iria para o log com o nome das pessoas.
    let aviso = "";
    app.get<{ Params: { token: string }; Querystring: Record<string, string> }>("/painel/:token", async (req, reply) => {
      if (!tokenConfere(req.params.token, painel.token)) return reply.code(404).send();
      reply.header("Cache-Control", "no-store").header("X-Robots-Tag", "noindex").type("text/html; charset=utf-8");
      const mostrar = aviso;
      aviso = "";
      return painel.pagina(`/painel/${req.params.token}`, mostrar, req.query ?? {});
    });
    app.post<{ Params: { token: string }; Body: Record<string, string> }>("/painel/:token/acao", async (req, reply) => {
      if (!tokenConfere(req.params.token, painel.token)) return reply.code(404).send();
      aviso = (await painel.acao(req.body ?? {}).catch((err) => `Não deu certo: ${String(err).slice(0, 200)}`)) || "";
      // Volta para a mesma tela (aba, conversa ou ficha): recarregar não repete a ação.
      // `voltaSegura` só deixa passar a consulta das abas, nunca outro endereço.
      const volta = voltaSegura(req.body?.volta);
      return reply.redirect(`/painel/${req.params.token}${volta ? `?${volta}` : ""}`, 303);
    });
  }

  const mcp = opts.mcp;
  if (mcp) {
    // O token vem no cabeçalho, não no caminho: o Claude Code manda `Authorization` e o
    // log do Fastify não registra cabeçalhos.
    app.post("/mcp", async (req, reply) => {
      const auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !tokenConfere(auth.slice(7).trim(), mcp.token)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const corpo = req.body as any;
      if (Array.isArray(corpo)) {
        const respostas = (await Promise.all(corpo.map((p) => tratarMcp(p, mcp)))).filter(Boolean);
        return respostas.length ? reply.send(respostas) : reply.code(202).send();
      }
      const r = await tratarMcp(corpo, mcp);
      return r ? reply.send(r) : reply.code(202).send();
    });
    // Sem sessão nem SSE: o GET (fluxo de eventos do servidor) não existe aqui.
    app.get("/mcp", async (_req, reply) => reply.code(405).header("Allow", "POST").send());
  }

  return app;
}
