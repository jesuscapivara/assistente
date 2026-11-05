import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { tratarMcp, type DepsMcp } from "./mcp.js";
import { lerArquivoGuardado } from "./midia.js";
import { voltaSegura } from "./painel.js";

function tokenConfere(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** O WhatsApp aceita documento até ~100 MB; aqui o limite é menor, porque o anexo fica no banco. */
export const LIMITE_ANEXO = 64 * 1024 * 1024;

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
  /** Download dos arquivos das conversas, com o mesmo token do MCP no cabeçalho. */
  arquivos?: {
    token: string;
    baixar(id: string): Promise<{ buffer: Buffer; mimetype: string; nome: string } | null>;
    /** Guarda um arquivo para anexar a um rascunho; devolve o id do anexo. */
    receber?(a: { dados: Buffer; nome: string }): Promise<{ id: number; nome: string; mimetype: string }>;
  };
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

  // O cartão do resumo e os anexos aprovados, buscados pela Evolution na hora do envio (ver midia.ts).
  app.get<{ Params: { id: string } }>("/midia/:id", async (req, reply) => {
    const a = lerArquivoGuardado(req.params.id.replace(/\.[a-z0-9]+$/i, ""));
    if (!a) return reply.code(404).send();
    return reply.header("Cache-Control", "no-store").type(a.tipo).send(a.dados);
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

  const arquivos = opts.arquivos;
  if (arquivos) {
    const autorizado = (req: { headers: Record<string, unknown> }) => {
      const auth = String(req.headers.authorization ?? "");
      return auth.startsWith("Bearer ") && tokenConfere(auth.slice(7).trim(), arquivos.token);
    };
    // Upload em binário puro; o nome vai no cabeçalho X-Nome-Arquivo (codificado), não no
    // caminho, para não ir ao log.
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, corpo, feito) => feito(null, corpo));
    app.post("/arquivo", async (req, reply) => {
      if (!autorizado(req)) return reply.code(401).send({ error: "unauthorized" });
      if (!arquivos.receber) return reply.code(404).send();
      const dados = req.body;
      if (!Buffer.isBuffer(dados) || !dados.length) return reply.code(400).send({ error: "mande o arquivo como application/octet-stream" });
      if (dados.length > LIMITE_ANEXO) return reply.code(413).send({ error: "arquivo acima de 64 MB" });
      let nome = "";
      try {
        nome = decodeURIComponent(String(req.headers["x-nome-arquivo"] ?? "")).trim();
      } catch {
        return reply.code(400).send({ error: "X-Nome-Arquivo mal codificado" });
      }
      if (!nome) return reply.code(400).send({ error: "falta o cabeçalho X-Nome-Arquivo" });
      return arquivos.receber({ dados, nome });
    });
    // Token no cabeçalho, como o MCP: no caminho iria para o log.
    app.get<{ Params: { id: string } }>("/arquivo/:id", async (req, reply) => {
      if (!autorizado(req)) return reply.code(401).send({ error: "unauthorized" });
      const a = await arquivos.baixar(req.params.id).catch((err) => {
        req.log.warn({ err: String(err).slice(0, 200) }, "download do arquivo falhou");
        return undefined;
      });
      if (a === null) return reply.code(404).send({ error: "arquivo não encontrado" });
      if (!a) return reply.code(502).send({ error: "o WhatsApp não entregou o arquivo (pode ter expirado)" });
      return reply
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`)
        .type(a.mimetype || "application/octet-stream")
        .send(a.buffer);
    });
  }

  return app;
}
