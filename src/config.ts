import { z } from "zod";

/**
 * Configuração pelo ambiente, validada na subida: faltar uma chave aqui é erro de
 * deploy, e é melhor o processo não subir do que subir lendo o WhatsApp sem conseguir
 * avisar o dono.
 */
const Esquema = z.object({
  PORT: z.coerce.number().int().default(3100),
  DATABASE_URL: z.string().min(1),

  // Evolution GO: o mesmo engine do KoreOS. Uma instância só para o número pessoal.
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_INSTANCE_TOKEN: z.string().min(1),
  // Segredo no caminho do webhook (`/webhook/<token>`): o engine é quem chama.
  WEBHOOK_TOKEN: z.string().min(16),

  // Números do dono, só dígitos com DDI (ex.: 5551999990000). O canal de controle é o
  // chat "mensagem para você". O WhatsApp novo pode entregar esse chat como LID
  // (`...@lid`): DONO_LIDS aceita os dois, separados por vírgula.
  DONO_NUMERO: z.string().regex(/^\d{10,15}$/),
  DONO_LIDS: z.string().default(""),
  DONO_NOME: z.string().default("Lucas"),

  // Claude, um modelo por tipo de trabalho. MODELO escreve na voz do dono e responde
  // as perguntas; MODELO_EXTRACAO lê cada conversa nova; MODELO_LEVE faz fichas,
  // lições, briefing, risco e a memória do chat. O comando `custo` mostra o efeito.
  ANTHROPIC_API_KEY: z.string().optional(),
  MODELO: z.string().default("claude-sonnet-5-5"),
  MODELO_EXTRACAO: z.string().default("claude-haiku-5-5"),
  MODELO_LEVE: z.string().default("claude-haiku-5-5"),

  // Áudio: opcional. Sem a chave, o áudio entra como "[áudio]" e não é transcrito.
  OPENAI_API_KEY: z.string().optional(),
  MODELO_TRANSCRICAO: z.string().default("gpt-4o-mini-transcribe"),

  // Telegram: opcional. Com o token e o chat do dono, os avisos e o resumo vão pelo bot
  // (com notificação) em vez do chat consigo mesmo do WhatsApp, que chega mudo. Os
  // comandos valem nos dois. Sem o chat id, o log mostra o id de quem escreveu ao bot.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Google (opcional): agenda e Gmail. Token gerado com scripts/google.mjs.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  // Horário em que dá para marcar coisas ("09-18"), para sugerir horários livres.
  EXPEDIENTE: z
    .string()
    .regex(/^\d{1,2}-\d{1,2}$/)
    .default("9-18"),
  // Compromisso confirmado com data vai para a agenda do Google.
  AGENDA_SINCRONIZAR: z
    .enum(["0", "1"])
    .default("1")
    .transform((v) => v === "1"),
  BRIEFING_MIN: z.coerce.number().int().min(5).default(45),
  // Compromisso com hora avisa este tanto antes ("às 13:30 te ligo" → 13:20).
  LEMBRETE_MIN: z.coerce.number().int().min(1).default(10),

  // KoreOS (opcional): o agente usa o MCP do KoreOS com o token pessoal do dono.
  KOREOS_MCP_URL: z.string().url().optional(),
  KOREOS_MCP_TOKEN: z.string().optional(),

  // Autonomia: nível de quem não tem nível próprio (0 só age quando pedido, 1 propõe
  // resposta, 2 envia se não vetar, 3 envia o simples direto) e a janela de veto do 2.
  AUTONOMIA_PADRAO: z.coerce.number().int().min(0).max(3).default(0),
  JANELA_VETO_MIN: z.coerce.number().int().min(1).default(10),
  COBRAR_APOS_DIAS: z.coerce.number().int().min(1).default(3),

  // Painel web (opcional). Sem token, a rota não existe.
  PAINEL_TOKEN: z.string().min(24).optional(),

  // Resumo da manhã como imagem (o cartão), com o texto curto na legenda. A Evolution
  // busca a imagem em URL_INTERNA (o endereço do assistente na rede do Docker; sem ela,
  // a origem de WEBHOOK_URL_PUBLICA). Se a imagem falhar, sai o texto.
  RESUMO_IMAGEM: z
    .enum(["0", "1"])
    .default("1")
    .transform((v) => v === "1"),
  URL_INTERNA: z.string().url().optional(),
  WEBHOOK_URL_PUBLICA: z.string().url().optional(),

  FUSO: z.string().default("America/Sao_Paulo"),
  RESUMO_HORA: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("07:30"),
  // Espera a conversa "assentar" antes de extrair: rajadas de mensagens viram uma chamada só.
  EXTRACAO_QUIETO_MIN: z.coerce.number().int().min(0).default(3),
  EXTRACAO_INTERVALO_SEG: z.coerce.number().int().min(10).default(60),
  // Retenção do texto bruto. A memória resumida por pessoa fica.
  RETENCAO_DIAS: z.coerce.number().int().min(30).default(365),
});

export type Config = z.infer<typeof Esquema>;

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Chave em branco no .env (`GOOGLE_CLIENT_ID=`) é chave ausente, não texto vazio.
  const limpo = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const r = Esquema.safeParse(limpo);
  if (!r.success) {
    const campos = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${campos}`);
  }
  return r.data;
}

/** JIDs que identificam o chat consigo mesmo (canal de controle). */
export function jidsDoDono(cfg: Pick<Config, "DONO_NUMERO" | "DONO_LIDS">): Set<string> {
  const jids = new Set<string>([`${cfg.DONO_NUMERO}@s.whatsapp.net`]);
  for (const lid of cfg.DONO_LIDS.split(",")) {
    const v = lid.trim();
    if (v) jids.add(v.includes("@") ? v : `${v}@lid`);
  }
  return jids;
}

export function googleLigado(cfg: Config): boolean {
  return Boolean(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.GOOGLE_REFRESH_TOKEN);
}

/** De onde a Evolution busca o que o assistente serve (o cartão do resumo). */
export function urlInterna(cfg: Config): string {
  if (cfg.URL_INTERNA) return cfg.URL_INTERNA.replace(/\/+$/, "");
  if (cfg.WEBHOOK_URL_PUBLICA) return new URL(cfg.WEBHOOK_URL_PUBLICA).origin;
  return `http://assistente:${cfg.PORT}`;
}

export function expediente(cfg: Config): { inicioH: number; fimH: number } {
  const [a, b] = cfg.EXPEDIENTE.split("-").map(Number);
  return { inicioH: a, fimH: b };
}
