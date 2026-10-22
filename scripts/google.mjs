/**
 * Gera o GOOGLE_REFRESH_TOKEN do assistente. Rode no SEU computador (precisa abrir o
 * navegador), uma vez:
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google.mjs
 *
 * O client é um "OAuth client ID" do tipo "Desktop app" no Google Cloud Console, com as
 * APIs Google Calendar e Gmail ativadas. O token impresso vai para o .env da VM.
 */
import http from "node:http";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.");
  process.exit(1);
}

// Os mesmos escopos de src/google.ts (ESCOPOS_GOOGLE).
const escopos = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];
const porta = 53682;
const redirect = `http://127.0.0.1:${porta}`;

const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
url.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: "code",
  scope: escopos.join(" "),
  access_type: "offline",
  prompt: "consent",
}).toString();

const servidor = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "/", redirect).searchParams.get("code");
  if (!code) {
    res.end("Sem código.");
    return;
  }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const j = await r.json();
  res.end(j.refresh_token ? "Pronto, pode fechar esta aba." : "Falhou, veja o terminal.");
  if (j.refresh_token) console.log(`\nColoque no .env da VM:\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
  else console.error("O Google não devolveu refresh token:", j);
  servidor.close();
});

servidor.listen(porta, "127.0.0.1", () => {
  console.log(`Abra no navegador e autorize com a sua conta Google:\n\n${url}\n`);
});
