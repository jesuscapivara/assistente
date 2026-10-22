/**
 * Cliente mínimo da Evolution GO para a instância do dono. O contrato é o que o
 * KoreOS já usa em produção (`services/evolutionApiService.js`): header `apikey` com
 * o token da instância, `POST /send/text` e `POST /message/downloadmedia`.
 */

export interface Evolution {
  enviarTexto(destino: string, texto: string): Promise<string | null>;
  baixarMidia(mensagem: Record<string, unknown>): Promise<{ buffer: Buffer; mimetype: string }>;
}

export function criarEvolution(baseUrl: string, tokenInstancia: string, fetcher: typeof fetch = fetch): Evolution {
  const base = baseUrl.replace(/\/+$/, "");

  async function chamar(caminho: string, corpo: unknown, timeoutMs = 20_000): Promise<unknown> {
    const res = await fetcher(`${base}${caminho}`, {
      method: "POST",
      headers: { apikey: tokenInstancia, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(corpo),
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
    async baixarMidia(mensagem) {
      const raw = (await chamar("/message/downloadmedia", { message: mensagem }, 45_000)) as Record<string, any>;
      const url = String(raw?.data?.base64 ?? raw?.base64 ?? "");
      const m = url.match(/^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s);
      if (!m) throw new Error("mídia sem conteúdo");
      return { buffer: Buffer.from(m[2], "base64"), mimetype: m[1] || "application/octet-stream" };
    },
  };
}

/** O id da mensagem enviada vem em lugares diferentes conforme a versão do engine. */
export function idDaResposta(raw: unknown): string | null {
  const r = raw as Record<string, any> | null;
  const candidatos = [r?.data?.Info?.ID, r?.data?.ID, r?.data?.id, r?.data?.key?.id, r?.Info?.ID, r?.ID, r?.id, r?.key?.id];
  for (const c of candidatos) if (typeof c === "string" && c) return c;
  return null;
}
