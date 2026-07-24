# aci-entsoe-proxy

Cloudflare Worker joka valittaa WEM:lle (Winter Endurance Monitor)
ENTSO-E Transparency Platform Restful API:n dataa. Sama arkkitehtuurimalli
kuin `aci-corine-proxy` ja `aci-fingrid-proxy`.

## Tila (2026-07-24) — /wind-generation LIVE JA TOIMII

Deployattu Cloudflaren natiivin Git-integraation kautta. Security Token
asetettu (Cloudflare Dashboard → Workers & Pages → Settings → Variables
and Secrets, EI GitHub Actions secrets).

`/wind-generation` LIVE-TESTATTU 2026-07-24: SE1 tuulivoima, 24h/96 pistetta
(PT15M), MktPSRType.psrType ("B19") tunnistui oikein ENSIMMAISELLA
yrityksella. Kaksi ydinjasennysrakennetta (GL_MarketDocument, Publication_
MarketDocument) validoitu paikallisesti ENTSO-E:n omaa esimerkki-XML:aa
vastaan ennen live-testia - molemmat lapaisivat.

`/cross-border-flow` ja `/installed-capacity` EI VIELA live-testattu.

## Kayttoonotto (jo tehty tallle deploylle, ohjeeksi jatkoa varten)

Cloudflare Dashboard → Workers & Pages → aci-entsoe-proxy → Settings →
Variables and Secrets → lisaa `ENTSOE_SECURITY_TOKEN` (tyyppi: Secret).
Cloudflare deployaa automaattisesti kun secret lisataan tai kun repoon
pushataan (natiivi Git-integraatio, ei GitHub Actions -workflowta).

## Reitit

- `GET /status` — proxyn tila ja tuetut tarjousalueet
- `GET /wind-generation?bzn=SE1&periodStart=2026-07-23T00:00:00Z&periodEnd=2026-07-24T00:00:00Z`
  — tuulivoiman toteutunut tuotanto per tarjousalue (documentType=A75, processType=A16) · **VAHVISTETTU TOIMIVAKSI**
- `GET /cross-border-flow?from=FI&to=SE1&periodStart=...&periodEnd=...`
  — fyysinen rajavirtaus MOLEMPIIN suuntiin (documentType=A11, 2 API-kutsua) · ei viela testattu
- `GET /installed-capacity?bzn=SE1&year=2026&psrType=B19`
  — asennettu kapasiteetti tuotantotyypeittain, vuositaso (documentType=A68) · ei viela testattu

## Tuetut tarjousalueet

FI, SE1, SE2, SE3, SE4, NO1, NO2, NO3, NO4, NO5, DK1, DK2
(EIC-koodit varmistettu ENTSO-E:n omasta Area List -dokumentaatiosta)

## Tunnetut rajoitukset

- Rate limit: 400 pyyntoa/min per IP+token (ENTSO-E:n oma raja)
- Cross-Border Physical Flows: yksi pyynto = yksi suunta, /cross-border-flow
  tekee automaattisesti 2 kutsua (molemmat suunnat)
- "Production and Generation Units" -master data (yksittaiset laitokset,
  tila existing/planned) EI VIELA integroitu - ks.
  aethercontinuity.org/tools/entsoe-integration-plan.md Askel 2b

## Viite

Taydellinen suunnitelma ja varmistetut API-parametrit:
https://aethercontinuity.org/tools/entsoe-integration-plan.md
