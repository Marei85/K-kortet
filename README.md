# Kökortet

Kösystem för receptionen: incheckning på terminal, väntrumsskärm, personalvy, och kundens mobil via QR-kod.

Sidan ligger på **https://marei85.github.io/K-kortet/**

| Enhet | Adress | Inloggning |
|---|---|---|
| iPad vid entrén | https://marei85.github.io/K-kortet/#terminal | Nej |
| TV i loungen | https://marei85.github.io/K-kortet/#skarm | Nej |
| Disk/verkstad | https://marei85.github.io/K-kortet/#personal | Personalens lösenord |

Kunder behöver ingen inloggning. QR-koden efter incheckningen öppnar deras ärende i mobilen.

Kön sparas i Firebase. Tills `FIREBASE_CONFIG` i `index.html` är ifylld körs sidan i **demoläge**: allt fungerar på en skärm, men kön delas inte mellan enheterna.

---

## Sätta upp databasen (en gång)

### 1. Skapa databasen i Firebase
1. Gå till https://console.firebase.google.com i Chrome eller Edge och logga in med ett Google-konto, gärna ett gemensamt företagskonto.
2. Skapa ett projekt, till exempel `kokortet`. Google Analytics behövs inte.
3. Välj **Databases & Storage → Firestore** (äldre utseende: Build → Firestore Database) och sedan **Create database**.
   - Utgåva: **Standard**. Databas-ID: låt det vara **(default)**.
   - Plats: **europe-north2 (Stockholm)** om den finns, annars **europe-north1 (Finland)**.
   - **Start in production mode**.
4. Öppna fliken **Rules**. Ersätt allt med innehållet i [`firestore.rules`](firestore.rules) och tryck **Publish**.

### 2. Skapa personalens inloggning
1. Välj **Authentication → Get started**.
2. Under **Sign-in method**: slå på **Email/Password**.
3. Under **Users → Add user**: e-post `personal@kokortet.se` (behöver inte finnas på riktigt) och ett starkt lösenord.
4. Under **Settings → Authorized domains → Add domain**: `marei85.github.io`
5. Under **Settings → User actions**: bocka ur **Enable create (sign-up)** och **Enable deletion** och tryck **Save**.
   Annars kan vem som helst skapa ett eget konto mot projektet med den publika nyckeln i sidan.
   Reglerna släpper ändå bara in `personal@kokortet.se`, men det ska inte heller gå att skapa konton.

### 3. Koppla sidan till databasen
1. Kugghjulet → **Project settings** → **Your apps** → webbikonen `</>`, registrera appen `Kökortet` (Hosting behövs inte).
2. Kopiera värdena i `firebaseConfig` och klistra in dem i `FIREBASE_CONFIG` högst upp i `index.html` på grenen `gh-pages`.
   Uppgifterna är inte hemliga. Säkerheten sköts av reglerna i `firestore.rules`.

Sidan uppdateras på GitHub Pages inom någon minut.

---

## Bra att veta
- **Logga aldrig in som personal på terminalen eller TV:n.** Håll inne det övre högra hörnet i en sekund för att visa menyn.
- **Personuppgifter:** fullständigt namn, mobilnummer och registreringsnummer kan bara inloggad personal läsa. Skärmar och kunders mobiler ser bara "Anna S.". Numret raderas när besöket avslutas, och gamla biljetter raderas efter det antal dagar som står under Inställningar.
- **Kostnad:** gratisnivån i Firebase räcker för några hundra besök om dagen.
- **Byta lösenord:** Firebase → Authentication → Users → kontot → Reset password.
- **Personalkontot** är `personal@kokortet.se`. Adressen står både i `firestore.rules` och som `STAFF_EMAIL` i `index.html`, så byter ni konto måste båda ändras.
- **Okända konton:** titta ibland under Authentication → Users. Där ska bara personalkontot finnas. Ta bort alla andra.
