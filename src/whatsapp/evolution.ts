/**
 * Cliente mínimo da Evolution GO para a instância do dono. O contrato é o que o
 * KoreOS já usa em produção (`services/evolutionApiService.js`): header `apikey` com
 * o token da instância, `POST /send/text` e `POST /message/downloadmedia`.
 */

export interface Evolution {
  enviarTexto(destino: string, texto: string): Promise<string | null>;
  /** Imagem por URL (o engine baixa e envia), com legenda. */
  enviarImagem(destino: string, url: string, legenda: string): Promise<string | null>;
  /** A agenda do celular sincronizada no engine: o nome que o dono deu a cada número. */
  contatos(): Promise<ContatoDaAgenda[]>;
  baixarMidia(mensagem: Record<string, unknown>): Promise<{ buffer: Buffer; mimetype: string }>;
}

export interface ContatoDaAgenda {
  jid: string;
  nome: string | null;
  push: string | null;
}

export function criarEvolution(baseUrl: string, tokenInstancia: string, fetcher: typeof fetch = fetch): Evolution {
  const base = baseUrl.replace(/\/+$/, "");

  async function chamar(caminho: string, corpo: unknown, timeoutMs = 20_000, metodo: "GET" | "POST" = "POST"): Promise<unknown> {
    const res = await fetcher(`${base}${caminho}`, {
      method: metodo,
      headers: { apikey: tokenInstancia, "Content-Type": "application/json", Accept: "application/json" },
      body: metodo === "POST" ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const texto = await res.text();
    if (!res.ok) throw new Error(`Evolution ${caminho} respondeu ${res.status}: ${texto.slice(0, 300)}`);
    try {
      return JSON.parse(texto);
    } catch {
      return texto;
    }
  }

  return {
    async enviarTexto(destino, texto) {
      const raw = await chamar("/send/text", { number: destino, text: texto });
      return idDaResposta(raw);
    },
    async enviarImagem(destino, url, legenda) {
      const raw = await chamar("/send/media", { number: destino, url, type: "image", caption: legenda, filename: "resumo.png" }, 45_000);
      return idDaResposta(raw);
    },
    async contatos() {
      return lerAgenda(await chamar("/user/contacts", null, 30_000, "GET"));
    },
    async baixarMidia(mensagem) {
      const raw = (await chamar("/message/downloadmedia", { message: mensagem }, 45_000)) as Record<string, any>;
      const url = String(raw?.data?.base64 ?? raw?.base64 ?? "");
      const m = url.match(/^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s);
      if (!m) throw new Error("mídia sem conteúdo");
      return { buffer: Buffer.from(m[2], "base64"), mimetype: m[1] || "application/octet-stream" };
    },
  };
}

/**
 * `/user/contacts` vem como mapa jid → info ou como lista, conforme a versão (o KoreOS
 * trata os dois em `parseContacts`). FullName é o nome salvo na agenda do celular.
 */
export function lerAgenda(raw: unknown): ContatoDaAgenda[] {
  const r = raw as Record<string, any> | null;
  const dados = r && typeof r === "object" && "data" in r ? r.data : r;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const pegar = (info: Record<string, any>, ...k: string[]) => {
    for (const x of k) {
      const v = texto(info?.[x] ?? info?.[x.charAt(0).toLowerCase() + x.slice(1)]);
      if (v) return v;
    }
    return null;
  };
  const saida: ContatoDaAgenda[] = [];
  const incluir = (jid: unknown, info: Record<string, any>) => {
    const j = texto(jid) ?? pegar(info, "JID", "Jid", "Id");
    if (!j || !j.includes("@") || j.endsWith("@g.us")) return;
    const nome = pegar(info, "FullName", "FirstName", "BusinessName");
    const push = pegar(info, "PushName");
    if (nome || push) saida.push({ jid: j.replace(/:\d+(?=@)/, ""), nome, push });
  };
  if (Array.isArray(dados)) for (const it of dados) incluir(it?.JID ?? it?.jid ?? it?.id, it ?? {});
  else if (dados && typeof dados === "object") for (const [k, v] of Object.entries(dados)) incluir(k, (v ?? {}) as Record<string, any>);
  return saida;
}

/** O id da mensagem enviada vem em lugares diferentes conforme a versão do engine. */
export function idDaResposta(raw: unknown): string | null {
  const r = raw as Record<string, any> | null;
  const candidatos = [r?.data?.Info?.ID, r?.data?.ID, r?.data?.id, r?.data?.key?.id, r?.Info?.ID, r?.ID, r?.id, r?.key?.id];
  for (const c of candidatos) if (typeof c === "string" && c) return c;
  return null;
}
