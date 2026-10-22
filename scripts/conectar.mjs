/**
 * Liga o seu número à Evolution GO e aponta o webhook para o assistente. Roda uma vez,
 * na VM (precisa alcançar o engine):
 *
 *   docker compose run --rm assistente node scripts/conectar.mjs --telefone 5551999990000 # código de pareamento (digita no celular)
 *   docker compose run --rm assistente node scripts/conectar.mjs   # ou QR code (qrcode.png)
 *
 * Variáveis: EVOLUTION_API_URL, EVOLUTION_GLOBAL_API_KEY, WEBHOOK_URL_PUBLICA
 * (ex.: http://assistente:3100/webhook/<WEBHOOK_TOKEN>), e opcionalmente
 * EVOLUTION_INSTANCE_TOKEN (sem ele, gera um e imprime para ir ao .env).
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const base = (process.env.EVOLUTION_API_URL ?? "").replace(/\/+$/, "");
const globalKey = process.env.EVOLUTION_GLOBAL_API_KEY ?? "";
const webhookUrl = process.env.WEBHOOK_URL_PUBLICA ?? "";
const nome = process.env.EVOLUTION_INSTANCIA ?? "assistente-pessoal";
const telefone = process.argv.includes("--telefone") ? process.argv[process.argv.indexOf("--telefone") + 1] : null;

if (!base || !globalKey || !webhookUrl) {
  console.error("Defina EVOLUTION_API_URL, EVOLUTION_GLOBAL_API_KEY e WEBHOOK_URL_PUBLICA.");
  process.exit(1);
}

async function chamar(metodo, caminho, chave, corpo) {
  const res = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { apikey: chave, "Content-Type": "application/json", Accept: "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`${metodo} ${caminho}: ${res.status} ${texto.slice(0, 300)}`);
  return texto ? JSON.parse(texto) : {};
}

const token = process.env.EVOLUTION_INSTANCE_TOKEN || randomBytes(24).toString("hex");
const existentes = await chamar("GET", "/instance/all", globalKey);
const lista = existentes?.data ?? existentes ?? [];
const ja = Array.isArray(lista) && lista.find((i) => i?.name === nome);
if (ja) {
  console.log(`Instância "${nome}" já existe; usando o token dela.`);
} else {
  await chamar("POST", "/instance/create", globalKey, { name: nome, token });
  console.log(`Instância "${nome}" criada.`);
}
const tokenInstancia = ja?.token ?? token;

// Só mensagens e estado da sessão: o assistente não precisa do resto.
const subscribe = ["MESSAGE", "Connected", "Disconnected", "LoggedOut"];
await chamar("POST", "/instance/connect", tokenInstancia, { webhookUrl, subscribe, immediate: true });

if (telefone) {
  const r = await chamar("POST", "/instance/pair", tokenInstancia, { phone: telefone, subscribe });
  console.log(`\nNo celular: WhatsApp > Aparelhos conectados > Conectar com número de telefone\nCódigo: ${r?.data?.PairingCode ?? JSON.stringify(r)}`);
} else {
  const r = await chamar("GET", "/instance/qr", tokenInstancia);
  const qr = String(r?.data?.qrcode ?? r?.data?.Qrcode ?? "");
  const m = qr.match(/^data:image\/png;base64,(.+)$/);
  if (!m) throw new Error("O engine não devolveu o QR code; tente com --telefone.");
  const arquivo = process.env.QR_ARQUIVO ?? "/tmp/qrcode.png";
  await writeFile(arquivo, Buffer.from(m[1], "base64"));
  console.log(`\nQR code salvo em ${arquivo}. No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.`);
}
if (!process.env.EVOLUTION_INSTANCE_TOKEN) console.log(`\nColoque no .env:\nEVOLUTION_INSTANCE_TOKEN=${tokenInstancia}`);
