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

  // Claude. O modelo pode ser trocado por rota sem mexer no código.
  ANTHROPIC_API_KEY: z.string().optional(),
  MODELO: z.string().default("claude-opus-5-5"),
  MODELO_EXTRACAO: z.string().default("claude-opus-5-5"),

  // Áudio: opcional. Sem a chave, o áudio entra como "[áudio]" e não é transcrito.
  OPENAI_API_KEY: z.string().optional(),
  MODELO_TRANSCRICAO: z.string().default("gpt-4o-mini-transcribe"),

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
  const r = Esquema.safeParse(env);
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
