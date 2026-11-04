# Kökortet

Kösystem för kundmottagning med incheckning på terminal, väntrumsskärm, personalvy och kundens mobil via QR-kod. Det stöder flera anläggningar.

Systemet körs på **Cloudflare Workers**. All logik, inloggning och behörighet ligger på servern. Webbsidan innehåller inga nycklar.

## Adresser

Varje anläggning har egna länkar (`<adress>` är er Cloudflare-adress, till exempel `kokortet.<konto>.workers.dev`):

| Enhet | Adress | Inloggning |
|---|---|---|
| iPad vid entrén | `https://<adress>/kungalv/#terminal` | Nej |
| TV i loungen | `https://<adress>/kungalv/#skarm` | Nej (kör i Microsoft Edge för rösten Sofie) |
| Disk/verkstad | `https://<adress>/kungalv/#personal` | Eget konto |
| Inställningar | `https://<adress>/kungalv/#installningar` | Administratör |

Anläggningar från start: `kungalv`, `svedala`, `linkoping`, `brannbacken`. Fler läggs till under Inställningar → Anläggningar, gärna som kopia av en befintlig.

Logga aldrig in på terminalen eller TV:n. Håll inne det övre högra hörnet i en sekund för att visa menyn.

## Roller

| Roll | Får |
|---|---|
| Personal | Ropa och hantera kunder på sina anläggningar |
| Anläggningsadministratör | Dessutom ändra anläggningens diskar, tjänster (på/av) och skärmtext, och lägga till personal på sina anläggningar |
| Central administratör | Allt, även gemensamma inställningar (företag, tjänster, texter, gallring) och nya anläggningar |

## Struktur

```
public/            webbsidan (statiska filer)
  index.html       sidans skal och utseende
  app.js           vyer och händelser – pratar bara med /api
  shared.js        delad logik: standardinställningar, central/lokal konfiguration
  _headers         säkerhetsrubriker (Content-Security-Policy m.m.)
src/
  worker.js        API: tar emot anrop, kontrollerar inloggning och behörighet
  hub.js           central Durable Object: konton, inloggningar, anläggningar, gemensam konfiguration
  site.js          en Durable Object per anläggning: dagens kö, realtid (WebSocket), gallring
  lib.js           hjälpfunktioner (lösenordshash, svar)
test/e2e.test.js   helhetstest i riktig webbläsare mot lokal server
wrangler.jsonc     Cloudflare-konfiguration
```

## Säkerhet och personuppgifter

- **Lösenord:** hashas med PBKDF2 och 100 000 iterationer. Inloggningen låses i tio minuter efter åtta fel i rad.
- **Sessioner:** en slumpad nyckel som sparas hashad på servern och gäller i 30 dagar. Den avslutas direkt om kontot stängs av eller ändras.
- **Behörighet:** varje anrop kontrolleras på servern mot roll och anläggning.
- **Vad publika vyer får:** terminal, TV och kundens mobil får bara kortnamn (”Anna S.”). Aldrig telefonnummer, regnummer eller efternamn, och aldrig hela kön.
- **Följlänken:** den i QR-koden är en lång slumpkod som inte går att gissa.
- **Mobilnummer:** raderas när besöket avslutas. Ärenden som inte avslutats rensas från personuppgifter natten efter, och gamla ärenden raderas automatiskt efter det antal dagar som står under Inställningar (standard 30).
- **Inga hemligheter i koden:** den enda hemligheten, `SETUP_CODE`, ligger som krypterad hemlighet i Cloudflare.

## Driftsättning (en gång)

1. Cloudflare → **Workers & Pages** → **Create application** → **Import a repository** → välj GitHub-repot.
   Namnet ska vara **kokortet**, samma som i `wrangler.jsonc`.
2. När första bygget är klart: Workern → **Settings** → **Variables and Secrets** → **Add**.
   Typ **Secret**, namn `SETUP_CODE`, och en lång kod som du själv väljer. Spara.
3. Öppna `https://<adress>/`. Ange startkoden och skapa den första centrala administratören.
   De fyra anläggningarna skapas automatiskt.

Varje push till produktionsgrenen publiceras automatiskt.

## Utveckling och test

```bash
npm install
echo "SETUP_CODE=valfri-lokal-kod" > .dev.vars      # används bara lokalt, ignoreras av git
npm run dev                                          # http://localhost:8787
npm i -D playwright && npx playwright install chromium
npm test                                             # startar en egen lokal server och kör helhetstestet
```
