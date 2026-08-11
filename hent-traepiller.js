const { chromium } = require("playwright");
const fs = require("node:fs");

// Tysk webshop (7% moms) - det er den I henter fra med jeres egen vognmand
const START_URL = "https://www.pillemadsen.dk/shop/traepiller-33s1.html";
const MAX_KATEGORISIDER = 6; // sikkerhed mod uendelig løkke hvis paginering ændrer sig

function danskTid() {
    return new Intl.DateTimeFormat("da-DK", {
        timeZone: "Europe/Copenhagen",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).format(new Date());
}

function danskDato() {
    // yyyy-mm-dd i dansk tidszone, så datoen matcher den morgen robotten faktisk kørte
    const dele = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const get = t => dele.find(d => d.type === t).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}

function tal(s) {
    if (s === undefined || s === null) return null;
    const n = Number(String(s).replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

const KENDTE_MAERKER = [
    "German Pellets", "Barlinek", "Heatlets", "Fågelfors", "Laxå", "Sylva",
    "Vida", "Fabich", "RW", "Olimp", "Lava", "Biomasa", "Samba", "Fireheat",
    "Vildbjerg", "Egetræpiller", "Olczyk", "HP", "Mix Pellets", "Big Bags"
];
function maerkeFraNavn(navn) {
    for (const m of KENDTE_MAERKER) {
        if (navn.toLowerCase().includes(m.toLowerCase())) return m;
    }
    if (/no\s*name/i.test(navn)) return "No name";
    // Fjern indledende størrelsesangivelser som "6 mm " og "8mm ", så et
    // produktnavn som "6 mm Mix Pellets" ikke ender med mærket "6"
    const uden = navn.replace(/^\s*\d{1,2}\s*mm\s*/i, "").trim();
    const foerste = (uden || navn).split(/\s+/)[0];
    // Et rent tal er aldrig et mærke
    return /^\d+$/.test(foerste) ? "Ukendt mærke" : foerste;
}

// "15/990 kg" eller "16/832" -> 990 / 832 kg pr. palle
function kgPrPalleFraNavn(navn) {
    const m = navn.match(/(\d{1,3})\s*\/\s*(\d{3,4})/);
    return m ? Number(m[2]) : null;
}

function typeFraNavn(navn) {
    return /briket/i.test(navn) ? "briket" : "pille";
}

function mmFraNavn(navn) {
    const m = navn.match(/(\d{1,2})\s*mm/i);
    return m ? Number(m[1]) : null;
}

// Specifikationer står i et felt på produktsiden (fanen "Beskrivelse 2"),
// men formatet varierer lidt fra producent til producent, fx:
//   "Brændværdi > 4,9 kwh/kg - ≤ 5,3 kWh/kg  Vand ≤ 10 %  Aske ≤ 0,6%  Svovl: ≤ 0,04 %  Aske smeltepunkt > 1400 °C"
//   "Brændværdi: 5,0 kwh  Vand: 5-7 %  Aske: ..."
// Parsingen er derfor "best effort" - felter der ikke kan genkendes bliver null.
function udtraekSpecs(rawTekst) {
    if (!rawTekst) return {};

    const smeltepunktMatch = rawTekst.match(/Aske\s*smeltepunkt[^A-ZÆØÅ\d]*?(\d+)\s*°?\s*C/i);
    let rest = rawTekst;
    if (smeltepunktMatch) rest = rest.replace(smeltepunktMatch[0], " ");

    const braendvaerdi = rest.match(
        /Brændværdi[^A-ZÆØÅ]*?(\d+[.,]\d+)\s*k?wh(?:\s*\/\s*kg)?(?:[^%\d]{0,20}(\d+[.,]\d+)\s*k?wh\s*\/?\s*kg)?/i
    );
    const vand = rest.match(/Vand[^A-ZÆØÅ]*?(\d+[.,]?\d*)\s*(?:-\s*(\d+[.,]?\d*))?\s*%/i);
    const aske = rest.match(/Aske[^A-ZÆØÅ%]*?(\d+[.,]?\d*)\s*(?:-\s*(\d+[.,]?\d*))?\s*%/i);
    const svovl = rest.match(/Svovl[^A-ZÆØÅ]*?(\d+[.,]?\d*)\s*%/i);

    return {
        braendvaerdiMinKwhKg: tal(braendvaerdi && braendvaerdi[1]),
        braendvaerdiMaxKwhKg: (braendvaerdi && braendvaerdi[2]) ? tal(braendvaerdi[2]) : tal(braendvaerdi && braendvaerdi[1]),
        fugtMaxProcent: (vand && vand[2]) ? tal(vand[2]) : tal(vand && vand[1]),
        askeMaxProcent: (aske && aske[2]) ? tal(aske[2]) : tal(aske && aske[1]),
        svovlMaxProcent: tal(svovl && svovl[1]),
        askeSmeltepunktGrader: smeltepunktMatch ? Number(smeltepunktMatch[1]) : null
    };
}

// Læser navn/pris/lagerstatus fra kategori-oversigten. Denne metode er testet grundigt
// og er den mest pålidelige kilde til pris og lagerstatus - produktsidernes egen pris kan
// vise en misvisende standardværdi, før man selv har valgt en mængde på siden.
async function laesKategoriside(page) {
    return page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="p.html"]'));
        const set = new Set();
        const resultater = [];
        for (const link of links) {
            const href = link.getAttribute("href");
            if (!href || set.has(href)) continue;
            let el = link, container = null;
            for (let i = 0; i < 6 && el; i++) {
                el = el.parentElement;
                if (!el) break;
                const t = el.innerText || "";
                if (t.includes("DKK") && /pr\.?\s*kg/i.test(t)) { container = el; break; }
            }
            if (!container) continue;
            set.add(href);
            resultater.push({ href, tekst: container.innerText || "" });
        }
        return resultater;
    });
}

async function findKategoriProdukter(browser) {
    let url = START_URL;
    const besoegteSider = new Set();
    const fundne = new Map();

    for (let side = 1; side <= MAX_KATEGORISIDER && url; side++) {
        console.log("Finder produkter på side " + side + ": " + url);
        besoegteSider.add(url);
        const page = await browser.newPage({ locale: "da-DK" });
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

        const raa = await laesKategoriside(page);
        for (const p of raa) {
            const fuldUrl = new URL(p.href, url).toString();
            if (!fundne.has(fuldUrl)) fundne.set(fuldUrl, p.tekst);
        }

        let naesteHref = null;
        const naeste = page.getByRole("link", { name: /næste/i });
        if (await naeste.count()) {
            naesteHref = await naeste.first().getAttribute("href").catch(() => null);
        }
        await page.close();

        if (!naesteHref) break;
        const nyUrl = new URL(naesteHref, url).toString();
        if (besoegteSider.has(nyUrl)) break;
        url = nyUrl;
    }
    return fundne; // Map<fuld produkt-url, tekst fra oversigtssiden>
}

// Besøger hver produktside for at læse specifikationer (aske/fugt/brændværdi)
// OG lagerbeholdning. Prisen hentes derimod fra oversigten, fordi produktsiden
// kan vise 0,00 kr, indtil man selv har valgt en mængde.
//
// Lagerbeholdningen står som fx "50+ PÅ LAGER" eller "3 PÅ LAGER". Plusset
// betyder "mindst" - Pillemadsen afrunder store beholdninger til 50+ og 100+.
// Pas på ikke at forveksle med "66 sække a 15 kg", som er sække pr. palle.
async function laesSpecsForProdukt(browser, url) {
    const page = await browser.newPage({ locale: "da-DK" });
    try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        const bodyTekst = (await page.locator("body").textContent().catch(() => "")) || "";

        let antalPaaLager = null, antalErMindst = false;
        const lagerMatch = bodyTekst.match(/(\d+)\s*(\+)?\s*P[ÅA]\s*LAGER/i);
        if (lagerMatch) {
            antalPaaLager = Number(lagerMatch[1]);
            antalErMindst = Boolean(lagerMatch[2]);
        }

        return { ...udtraekSpecs(bodyTekst), antalPaaLager, antalErMindst };
    } catch (err) {
        console.warn("Kunne ikke læse produktside " + url + ": " + err.message);
        return {};
    } finally {
        await page.close();
    }
}

function beregnDagligOpsummering(produkter, dato, hentetDanskTid) {
    const paaLager = produkter.filter(p => p.paaLager === true);
    const medPris = paaLager.filter(p => p.prisPrKg !== null);
    const seks = medPris.filter(p => p.mm === 6);
    const otte = medPris.filter(p => p.mm === 8);

    const gns = arr => arr.length ? Math.round((arr.reduce((s, p) => s + p.prisPrKg, 0) / arr.length) * 100) / 100 : null;
    const billigste = medPris.length ? Math.min(...medPris.map(p => p.prisPrKg)) : null;

    return {
        dato,
        hentetDanskTid,
        antalTotal: produkter.length,
        antalPaaLager: paaLager.length,
        gnsPris6mmPaaLager: gns(seks),
        gnsPris8mmPaaLager: gns(otte),
        billigstePaaLager: billigste
    };
}

function opdaterHistorik(dagensOpsummering) {
    let historik = [];
    try {
        const eksisterende = JSON.parse(fs.readFileSync("historik.json", "utf8"));
        if (Array.isArray(eksisterende)) historik = eksisterende;
    } catch (e) {
        historik = [];
    }
    const idx = historik.findIndex(h => h.dato === dagensOpsummering.dato);
    if (idx >= 0) historik[idx] = dagensOpsummering;
    else historik.push(dagensOpsummering);
    historik.sort((a, b) => a.dato.localeCompare(b.dato));
    fs.writeFileSync("historik.json", JSON.stringify(historik, null, 2), "utf8");
    return historik;
}

const EUR_TIL_DKK = 7.46; // omtrentlig fastkurs, brugt kun til visning

// Kendte historiske DEPI-tal (Deutsches Pelletinstitut). Bruges som selvhelbredende
// bund-niveau, så det tyske markedsindeks aldrig står tomt - selv hvis filen på GitHub
// skulle mangle eller blive nulstillet. Robotten lægger blot nye måneder oveni.
// Hele den offentliggjorte serie, aflæst direkte fra DEPI's pristabel
// (bundesweiter Pelletpreis, 6 t). Sammenhængende måneder gør det muligt at
// regne sæsonmønster og 12-måneders gennemsnit ud - det kunne den tidligere,
// hullede serie ikke.
const SEED_TYSK_MARKEDSINDEKS = [
    { dato: "2025-01", eurPrTon: 306.35 },
    { dato: "2025-02", eurPrTon: 363.21 },
    { dato: "2025-03", eurPrTon: 380.20 },
    { dato: "2025-04", eurPrTon: 343.14 },
    { dato: "2025-05", eurPrTon: 315.89 },
    { dato: "2025-06", eurPrTon: 302.45 },
    { dato: "2025-07", eurPrTon: 302.69 },
    { dato: "2025-08", eurPrTon: 310.82 },
    { dato: "2025-09", eurPrTon: 335.04 },
    { dato: "2025-10", eurPrTon: 366.25 },
    { dato: "2025-11", eurPrTon: 392.62 },
    { dato: "2025-12", eurPrTon: 397.46 },
    { dato: "2026-01", eurPrTon: 405.33 },
    { dato: "2026-02", eurPrTon: 422.73 },
    { dato: "2026-03", eurPrTon: 419.20 },
    { dato: "2026-04", eurPrTon: 405.11 },
    { dato: "2026-05", eurPrTon: 388.09 },
    { dato: "2026-06", eurPrTon: 376.77 }
].map(m => ({ ...m, dkkPrKg: Math.round((m.eurPrTon / 1000 * 7.46) * 100) / 100 }));

// Måneder der én gang er blevet skrevet forkert til filen, og som skal fjernes
// igen ved næste kørsel. 2026-07 var i virkeligheden maj-prisen sat på juli, og
// fik appen til at vise et stigende marked, mens det reelt faldt.
const FEJLRAMTE_MAANEDER = ["2026-07"];
const TYSKE_MAANEDSNAVNE = {
    "januar": 1, "februar": 2, "märz": 3, "april": 4, "mai": 5, "juni": 6,
    "juli": 7, "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12
};

// Bedste-forsøg: DEPI (Deutsches Pelletinstitut) udgiver et nyt indlæg hver måned
// under en ny, ikke-forudsigelig URL. Vi finder derfor det nyeste indlæg fra deres
// oversigtsside i stedet for at gætte på en fast adresse. Fejler dette (fx fordi DEPI
// har ændret sidestruktur), springer vi det bare over - det må aldrig vælte hovedkørslen.
async function hentTyskMarkedsindeks(browser) {
    const page = await browser.newPage({ locale: "de-DE" });
    try {
        await page.goto("https://www.depi.de/mediathek/", { waitUntil: "networkidle", timeout: 60000 });
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/mediathek/d/"]'))
                .map(a => ({ href: a.getAttribute("href"), tekst: (a.textContent || "").toLowerCase() }))
                .filter(l => l.href && l.tekst.includes("pelletpreis"));
        });
        if (!links.length) throw new Error("Fandt ingen artikler om pelletpris på DEPI's oversigtsside");

        const url = new URL(links[0].href, "https://www.depi.de/").toString();
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        const tekst = (await page.locator("body").textContent().catch(() => "")) || "";

        // Måned og pris skal stå i SAMME sætning. Tidligere blev de to hentet
        // hver for sig et vilkårligt sted i artiklen, og så kunne fx maj-prisen
        // ende under overskriftens "Juli 2026". Vi deler derfor op i sætninger
        // og kræver, at begge dele findes i den samme.
        const MAANED_RE = /\b(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(20\d{2})\b/i;
        const PRIS_RE = /durchschnittlich\s+([\d.,]+)\s*Euro/i;

        let dato = null, eurPrTon = null;
        for (const saetning of tekst.split(/(?<=[.!?])\s+/)) {
            const p = saetning.match(PRIS_RE);
            const m = saetning.match(MAANED_RE);
            if (p && m) {
                eurPrTon = Number(p[1].replace(/\./g, "").replace(",", "."));
                dato = m[2] + "-" + String(TYSKE_MAANEDSNAVNE[m[1].toLowerCase()]).padStart(2, "0");
                break;
            }
        }
        if (dato === null || eurPrTon === null) {
            throw new Error("Fandt ikke måned og pris i samme sætning i DEPI-artiklen: " + url);
        }

        // Rimelighedstjek. Uden dem kan en enkelt underlig artikel forgifte hele
        // serien, og en forkert måned vender prisretningen på hovedet i appen.
        if (!(eurPrTon > 150 && eurPrTon < 900)) {
            throw new Error("DEPI-pris uden for rimeligt interval: " + eurPrTon + " €/t (" + url + ")");
        }
        const nu = new Date();
        const senesteRimelige = nu.getFullYear() * 12 + nu.getMonth();      // indeværende måned
        const [dAar, dMdr] = dato.split("-").map(Number);
        const datoIndeks = dAar * 12 + (dMdr - 1);
        if (datoIndeks > senesteRimelige) {
            throw new Error("DEPI-artikel angiver en fremtidig måned (" + dato + ") - ignoreret");
        }

        const nytPunkt = {
            dato,
            eurPrTon: Math.round(eurPrTon * 100) / 100,
            dkkPrKg: Math.round((eurPrTon / 1000 * EUR_TIL_DKK) * 100) / 100,
            kilde: url
        };

        let data;
        try {
            data = JSON.parse(fs.readFileSync("tysk-markedsindeks.json", "utf8"));
        } catch (e) {
            data = { kilde: "Deutsches Pelletinstitut (DEPI)", eurPrDkk: EUR_TIL_DKK, maaneder: [] };
        }
        if (!Array.isArray(data.maaneder)) data.maaneder = [];

        // Fjern måneder vi ved er skrevet forkert, medmindre de netop nu er
        // bekræftet igen fra DEPI's egen artikel.
        data.maaneder = data.maaneder.filter(m => !(FEJLRAMTE_MAANEDER.includes(m.dato) && m.dato !== dato));

        // Seed'en er facit. Tidligere rettede vi kun huller, så en forkert værdi
        // blev liggende for evigt - nu overskrives den også.
        for (const seedPunkt of SEED_TYSK_MARKEDSINDEKS) {
            const i = data.maaneder.findIndex(m => m.dato === seedPunkt.dato);
            const punkt = { ...seedPunkt, kilde: "https://www.depi.de/pelletpreis-wirtschaftlichkeit/" };
            if (i < 0) {
                data.maaneder.push(punkt);
            } else if (Math.abs((data.maaneder[i].eurPrTon || 0) - seedPunkt.eurPrTon) > 0.01) {
                console.warn("Retter forkert DEPI-tal for", seedPunkt.dato,
                    data.maaneder[i].eurPrTon, "->", seedPunkt.eurPrTon);
                data.maaneder[i] = punkt;
            }
        }

        const idx = data.maaneder.findIndex(m => m.dato === dato);
        if (idx >= 0) data.maaneder[idx] = nytPunkt;
        else data.maaneder.push(nytPunkt);
        data.maaneder.sort((a, b) => a.dato.localeCompare(b.dato));

        fs.writeFileSync("tysk-markedsindeks.json", JSON.stringify(data, null, 2), "utf8");
        console.log("Tysk markedsindeks opdateret for", dato, "->", eurPrTon, "€/t");
    } catch (err) {
        console.warn("Kunne ikke opdatere tysk markedsindeks (springer over):", err.message);
    } finally {
        await page.close();
    }
}

// ---------------------------------------------------------------------------
// SIGNALMOTOR
//
// Alt, der ligner en vurdering, regnes her - deterministisk, af robotten.
// AI'en får resultatet som færdigt input og skal KUN formulere det på dansk.
// Den må aldrig selv afgøre, om markedet er på vej op eller ned.
//
// Vurderingen bygger på tre lag, sorteret efter hvor meget vi faktisk ved:
//   1. Sæson   - stærkest belæg, rygraden i vurderingen
//   2. Niveau  - hvor ligger prisen i forhold til de seneste 12 måneder
//   3. Lokalt  - Pillemadsens egne tal; må rykke vurderingen, ikke sætte den
// ---------------------------------------------------------------------------

// Sæsonfaser. Bevidst grove: med kun halvandet års DEPI-data kan trend og sæson
// ikke skilles statistisk ad endnu, så det her er en branchekendt tommelfingerregel,
// ikke et udregnet indeks. Når serien er lang nok, kan den afløses af rigtige tal.
const SAESONFASER = {
    1:  { navn: "højsæson",     score:  1.0, tekst: "vi er midt i fyringssæsonen, hvor priserne typisk topper" },
    2:  { navn: "højsæson",     score:  1.0, tekst: "vi er midt i fyringssæsonen, hvor priserne typisk topper" },
    3:  { navn: "nedtrapning",  score:  0.3, tekst: "sæsonen er ved at slutte, og priserne plejer at falde herfra" },
    4:  { navn: "nedtrapning",  score:  0.3, tekst: "sæsonen er ved at slutte, og priserne plejer at falde herfra" },
    5:  { navn: "nedtrapning",  score:  0.3, tekst: "priserne plejer stadig at falde et stykke ind i foråret" },
    6:  { navn: "sommerbund",   score: -1.0, tekst: "vi er i sommerbunden, hvor priserne typisk er lavest på året" },
    7:  { navn: "sommerbund",   score: -1.0, tekst: "vi er i sommerbunden, hvor priserne typisk er lavest på året" },
    8:  { navn: "sommerbund",   score: -1.0, tekst: "vi er i sommerbunden, hvor priserne typisk er lavest på året" },
    9:  { navn: "opbygning",    score: -0.3, tekst: "fyringssæsonen nærmer sig, og priserne plejer at stige herfra" },
    10: { navn: "opbygning",    score: -0.3, tekst: "fyringssæsonen er begyndt, og priserne plejer at stige videre" },
    11: { navn: "højsæson",     score:  1.0, tekst: "vi er inde i fyringssæsonen, hvor priserne typisk topper" },
    12: { navn: "højsæson",     score:  1.0, tekst: "vi er inde i fyringssæsonen, hvor priserne typisk topper" }
};

function laesJson(sti, standard) {
    try { return JSON.parse(fs.readFileSync(sti, "utf8")); } catch (e) { return standard; }
}

// Hvor gammelt er et månedstal som "2026-06"? DEPI halter typisk 4-7 uger,
// og det skal appen sige højt i stedet for at lade tallet ligne dagens pris.
function alderIDage(maanedsDato) {
    const [aar, mdr] = maanedsDato.split("-").map(Number);
    const slutPaaMaaned = new Date(Date.UTC(aar, mdr, 0));
    return Math.max(0, Math.round((Date.now() - slutPaaMaaned.getTime()) / 86400000));
}

function beregnSignaler(dagensOpsummering, drivere) {
    const depi = laesJson("tysk-markedsindeks.json", { maaneder: [] });
    const historik = laesJson("historik.json", []);
    const maaneder = (depi.maaneder || []).slice().sort((a, b) => a.dato.localeCompare(b.dato));

    const signaler = [];
    const forbehold = [];
    const nu = new Date();
    const maanedNr = nu.getMonth() + 1;

    // ---- Lag 1: sæson -----------------------------------------------------
    const fase = SAESONFASER[maanedNr];
    signaler.push({
        navn: "Sæson", status: fase.navn, effekt: fase.score < 0 ? "taler for køb" : (fase.score > 0 ? "taler for at vente" : "neutral"),
        vaegt: 1.0, dato: null, aktiv: true,
        note: "Tommelfingerregel ud fra fyringssæsonen, ikke et udregnet indeks."
    });

    // ---- Lag 2: niveau vs. de seneste 12 måneder --------------------------
    // Bevidst IKKE min/max over hele serien: 2026 ligger strukturelt højere end
    // 2025, så et min/max-mål ville dømme hver eneste måned i 2026 som "dyr".
    let niveauScore = 0, niveauTekst = null, senesteDepi = null, pctVs12 = null;
    if (maaneder.length >= 12) {
        senesteDepi = maaneder[maaneder.length - 1];
        const sidste12 = maaneder.slice(-12);
        const snit12 = sidste12.reduce((s, m) => s + m.eurPrTon, 0) / 12;
        pctVs12 = Math.round(((senesteDepi.eurPrTon - snit12) / snit12) * 1000) / 10;

        if (pctVs12 <= -5)      { niveauScore = -1.0; niveauTekst = "markedet ligger klart under det seneste års gennemsnit"; }
        else if (pctVs12 <= -2) { niveauScore = -0.5; niveauTekst = "markedet ligger lidt under det seneste års gennemsnit"; }
        else if (pctVs12 <   2) { niveauScore =  0.0; niveauTekst = "markedet ligger på linje med det seneste års gennemsnit"; }
        else if (pctVs12 <   5) { niveauScore =  0.5; niveauTekst = "markedet ligger lidt over det seneste års gennemsnit"; }
        else                    { niveauScore =  1.0; niveauTekst = "markedet ligger klart over det seneste års gennemsnit"; }

        signaler.push({
            navn: "Prisniveau (DEPI)", status: (pctVs12 >= 0 ? "+" : "") + pctVs12 + "% vs. 12 mdr.",
            effekt: niveauScore < 0 ? "taler for køb" : (niveauScore > 0 ? "taler for at vente" : "neutral"),
            vaegt: 0.8, dato: senesteDepi.dato, aktiv: true,
            note: "Målt mod de seneste 12 måneders gennemsnit, ikke mod hele seriens spænd."
        });
    } else {
        forbehold.push("Der er endnu ikke 12 måneders DEPI-data, så prisniveauet indgår ikke i vurderingen.");
    }

    // ---- Lag 3: lokal afvigelse hos Pillemadsen ---------------------------
    // Må højst rykke vurderingen ét hak. Datagrundlaget er tyndt, og lager-
    // hypotesen har endnu ikke set en vinter.
    let lokalScore = 0, lokalTekst = null, egenPct = null;
    const medPris = historik.filter(h => h.gnsPris6mmPaaLager !== null && h.gnsPris6mmPaaLager !== undefined);
    if (medPris.length >= 14) {
        const nuPris = medPris[medPris.length - 1].gnsPris6mmPaaLager;
        const foerPris = medPris[Math.max(0, medPris.length - 31)].gnsPris6mmPaaLager;
        egenPct = Math.round(((nuPris - foerPris) / foerPris) * 1000) / 10;
        if (egenPct >= 3)       { lokalScore = -0.4; lokalTekst = "Pillemadsen har selv sat priserne op"; }
        else if (egenPct <= -3) { lokalScore =  0.4; lokalTekst = "Pillemadsen har selv sat priserne ned"; }
        signaler.push({
            navn: "Pillemadsens egen pris", status: (egenPct >= 0 ? "+" : "") + egenPct + "% på 30 dage",
            effekt: lokalScore < 0 ? "taler for køb" : (lokalScore > 0 ? "taler for at vente" : "neutral"),
            vaegt: 0.4, dato: medPris[medPris.length - 1].dato, aktiv: lokalScore !== 0, note: null
        });
    } else {
        forbehold.push("Der er endnu ikke 30 dages prishistorik hos Pillemadsen, så deres egen prisudvikling indgår ikke.");
    }

    // Lagerudviklingen registreres og vises, men indgår BEVIDST ikke i
    // vurderingen endnu: hypotesen "lager falder -> pris stiger" er ikke
    // efterprøvet, og der er endnu ikke gået en vinter med data.
    const t7 = drivere && drivere.lager && drivere.lager.tendens7dage;
    if (t7 && t7.beholdning) {
        signaler.push({
            navn: "Lagerbevægelse", status: (t7.beholdning.pctAendring >= 0 ? "+" : "") + t7.beholdning.pctAendring + "% på 7 dage",
            effekt: "under observation", vaegt: 0, dato: drivere.hentetDanskTid || null, aktiv: false,
            note: "Vises, men tæller ikke med. Signalet skal ses gennem en fyringssæson, før vi stoler på det."
        });
    }

    // ---- Samlet købsvurdering --------------------------------------------
    const bidrag = [{ vaegt: 1.0, score: fase.score }];
    if (niveauTekst) bidrag.push({ vaegt: 0.8, score: niveauScore });
    const samletVaegt = bidrag.reduce((s, b) => s + b.vaegt, 0);
    let score = bidrag.reduce((s, b) => s + b.vaegt * b.score, 0) / samletVaegt;
    score = Math.max(-1, Math.min(1, score + lokalScore * 0.5));

    let niveau, overskrift;
    if (score <= -0.5)       { niveau = "godt";        overskrift = "Godt tidspunkt at købe"; }
    else if (score <= -0.15) { niveau = "fornuftigt";  overskrift = "Fornuftigt tidspunkt"; }
    else if (score <=  0.35) { niveau = "neutralt";    overskrift = "Neutralt"; }
    else                     { niveau = "vent";        overskrift = "Vent hvis du kan"; }

    const begrundelser = [fase.tekst];
    if (niveauTekst) begrundelser.push(niveauTekst);
    if (lokalTekst) begrundelser.push(lokalTekst);

    // ---- Prognose: kort horisont, ingen kurve -----------------------------
    // Vi udtaler os bevidst kun 2-4 uger frem. Længere sigt end sæsonmønsteret
    // kan vi ikke belægge, og en prognosekurve ville foregive andet.
    let prognoseRetning;
    if ([8, 9, 10].includes(maanedNr))       prognoseRetning = "svagt stigende";
    else if ([11, 12, 1].includes(maanedNr)) prognoseRetning = "stigende eller højt";
    else if ([2, 3, 4, 5].includes(maanedNr)) prognoseRetning = "svagt faldende";
    else                                      prognoseRetning = "stabil omkring bunden";

    let momentumTekst = "";
    if (maaneder.length >= 3) {
        const a = maaneder[maaneder.length - 3].eurPrTon, b = maaneder[maaneder.length - 1].eurPrTon;
        const pct = Math.round(((b - a) / a) * 1000) / 10;
        momentumTekst = `DEPI er gået ${pct >= 0 ? "op" : "ned"} ${Math.abs(pct)}% over de seneste to målte måneder.`;
    }

    const senesteAlder = senesteDepi ? alderIDage(senesteDepi.dato) : null;
    if (senesteAlder !== null && senesteAlder > 35) {
        forbehold.push(`DEPI's nyeste offentliggjorte tal er fra ${senesteDepi.dato} og altså omkring ${senesteAlder} dage gammelt. Det beskriver retningen, ikke dagens pris.`);
    }
    forbehold.push("DEPI måler løst indblæste piller inkl. moms leveret inden for 50 km. Pillemadsen sælger sække på paller, du selv henter. De to tal kan sammenlignes i retning, aldrig i niveau.");

    const resultat = {
        beregnetUTC: new Date().toISOString(),
        beregnetDanskTid: nu.toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" }),
        koebsvurdering: {
            niveau, overskrift, score: Math.round(score * 100) / 100,
            position: Math.round(((score + 1) / 2) * 1000) / 10,
            begrundelse: begrundelser.join(", og ") + "."
        },
        marked: {
            status: momentumTekst.includes("ned") ? "faldende" : (momentumTekst.includes("op") ? "stigende" : "ukendt"),
            dataDato: senesteDepi ? senesteDepi.dato : null,
            alderDage: senesteAlder,
            pctVs12Maaneder: pctVs12,
            tekst: momentumTekst
        },
        lokal: {
            dataDato: dagensOpsummering ? dagensOpsummering.dato : null,
            billigstePaaLager: dagensOpsummering ? dagensOpsummering.billigstePaaLager : null,
            gnsPris6mm: dagensOpsummering ? dagensOpsummering.gnsPris6mmPaaLager : null,
            pctEgenPris30dage: egenPct,
            paaLager: drivere && drivere.lager ? drivere.lager.antalPaaLager : null,
            antalTotal: drivere && drivere.lager ? drivere.lager.antalTotal : null
        },
        transport: {
            dataDato: drivere && drivere.diesel ? drivere.diesel.dato : null,
            dieselDKEurPrLiter: drivere && drivere.diesel ? drivere.diesel.dieselDKEurPrLiter : null,
            note: "Påvirker din leverede pris, ikke pelletmarkedet."
        },
        prognose: { horisont: "2-4 uger", retning: prognoseRetning, tekst: momentumTekst },
        signaler,
        forbehold
    };

    fs.writeFileSync("signaler.json", JSON.stringify(resultat, null, 2), "utf8");
    console.log("Signaler beregnet:", overskrift, "(score", resultat.koebsvurdering.score + ")");
    return resultat;
}

// Beder en gratis AI (Groq) om en kort dansk forklaring på markedet ud fra dagens
// tal. Nøglen læses UDELUKKENDE fra miljøvariablen GROQ_API_KEY (sat som en GitHub
// Secret) - den står aldrig i denne fil. Fejler dette, springes det bare over.
async function hentAiAnalyse(produkter, dagensOpsummering, drivere, signaler) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.warn("Ingen GROQ_API_KEY sat - springer AI-analyse over.");
        return;
    }
    try {
        const paaLager = produkter.filter(p => p.paaLager === true);
        const udsolgteMaerker = Array.from(new Set(
            produkter.filter(p => p.paaLager === false).map(p => p.maerke)
        )).filter(m => !paaLager.some(p => p.maerke === m));

        let depiSaetning = "";
        try {
            const depiData = JSON.parse(fs.readFileSync("tysk-markedsindeks.json", "utf8"));
            if (Array.isArray(depiData.maaneder) && depiData.maaneder.length) {
                const maaneder = depiData.maaneder.slice().sort((a, b) => a.dato.localeCompare(b.dato));
                const seneste = maaneder[maaneder.length - 1];
                depiSaetning = `Tysk markedsindeks (DEPI) for ${seneste.dato}: ${seneste.dkkPrKg} kr/kg.`;

                const [aar, maaned] = seneste.dato.split("-");
                const sidsteAar = maaneder.find(m => m.dato === (Number(aar) - 1) + "-" + maaned);
                if (sidsteAar) {
                    const pct = Math.round(((seneste.dkkPrKg - sidsteAar.dkkPrKg) / sidsteAar.dkkPrKg) * 100);
                    depiSaetning += ` Det er ${pct >= 0 ? "+" : ""}${pct}% i forhold til samme måned sidste år (${sidsteAar.dato}: ${sidsteAar.dkkPrKg} kr/kg).`;
                }
            }
        } catch (e) { /* ingen DEPI-data endnu, det er ok */ }

        const linjerDE = [], linjerLokal = [], linjerBaggrund = [];

        if (drivere && drivere.vejrDE) {
            const v = drivere.vejrDE;
            let l = `Vejr i Tyskland: ${v.snitTemp14dage} °C i snit de kommende 14 dage.`;
            if (!v.fyringssaeson) {
                l += ` Det er uden for fyringssæsonen - varmebehovet er minimalt, og vejret påvirker derfor ikke efterspørgslen nævneværdigt lige nu.`;
            } else if (v.pctAendringGraddage !== null) {
                l += ` Fyringsbehovet (${v.graddage14dage} graddage) er ${v.pctAendringGraddage >= 0 ? "+" : ""}${v.pctAendringGraddage}% i forhold til samme periode sidste år - ${v.retning}.`;
            } else if (v.gradForskelVsSidsteAar !== null) {
                l += ` Det er ${Math.abs(v.gradForskelVsSidsteAar)} grader ${v.gradForskelVsSidsteAar >= 0 ? "varmere" : "koldere"} end samme periode sidste år.`;
            }
            linjerDE.push(l);
        }
        if (drivere && drivere.elprisDE && drivere.elprisDE.snitSeneste7DageEurMwh !== null) {
            const e = drivere.elprisDE;
            // Ingen årsagsmærkat: pillefabrikker køber på lange kontrakter og
            // bruger overvejende savværksrester, så day-ahead-spot siger meget lidt
            // om produktionsomkostningen. Flyttet til BAGGRUND.
            linjerBaggrund.push(`Tysk elpris (day-ahead, kun til orientering): ${e.snitSeneste7DageEurMwh} €/MWh seneste 7 dage mod ${e.snitForrige7DageEurMwh} ugen før.`);
        }
        if (drivere && drivere.depi) {
            const d = drivere.depi;
            let l = `Tysk markedsindeks (DEPI): ${d.dkkPrKg} kr/kg for ${d.dato}.`;
            if (d.pctAarTilAar !== null) {
                l += ` Niveau: ${d.pctAarTilAar >= 0 ? "+" : ""}${d.pctAarTilAar}% i forhold til samme måned sidste år (${d.niveauVsSidsteAar}).`;
            }
            if (d.pctSeneste2Mdr !== null && d.pctSeneste2Mdr !== undefined) {
                l += ` Retning: ${d.pctSeneste2Mdr >= 0 ? "+" : ""}${d.pctSeneste2Mdr}% over de to senest offentliggjorte måneder - ${d.retning}.`;
            }
            l += ` Bemærk: niveau og retning er to forskellige ting. En pris kan ligge højt over sidste år og samtidig være på vej ned.`;
            linjerDE.push(l);
        }
        if (drivere && drivere.produktion) {
            const p = drivere.produktion;
            let l = `Tysk pelletproduktion ${p.kvartal}: ${p.produktionTon.toLocaleString("da-DK")} ton`;
            if (p.pctVsSammeKvartalSidsteAar !== null) l += `, ${p.pctVsSammeKvartalSidsteAar >= 0 ? "+" : ""}${p.pctVsSammeKvartalSidsteAar}% vs. samme kvartal sidste år`;
            else if (p.pctVsForrigeKvartal !== null) l += `, ${p.pctVsForrigeKvartal >= 0 ? "+" : ""}${p.pctVsForrigeKvartal}% vs. forrige kvartal`;
            l += p.retning === "ukendt"
                ? ` Der er endnu ikke nok kvartaler til at sige, om forsyningen er høj eller lav.`
                : ` - forsyning ${p.retning}.`;
            // Fjernet: "...så savværksaktiviteten er afgørende for råvareudbuddet."
            // Sætningen er sand nok som strukturel baggrund, men vi måler INTET om
            // savværksaktivitet. Den inviterede AI'en til at spekulere i noget, den
            // ikke har tal på - og til at fremstille gættet som en forklaring.
            if (p.saegerestholzProcent !== null) l += ` ${p.saegerestholzProcent}% af råmaterialet er savværksrester.`;
            linjerDE.push(l);
        }

        if (drivere && drivere.vejrDK) {
            const v = drivere.vejrDK;
            let l = `Vejr i Danmark: ${v.snitTemp14dage} °C i snit de kommende 14 dage.`;
            if (!v.fyringssaeson) {
                l += ` Uden for fyringssæsonen - dansk efterspørgsel er derfor ikke vejrdrevet lige nu.`;
            } else if (v.pctAendringGraddage !== null) {
                l += ` Fyringsbehovet (${v.graddage14dage} graddage) er ${v.pctAendringGraddage >= 0 ? "+" : ""}${v.pctAendringGraddage}% vs. sidste år - ${v.retning}.`;
            } else if (v.gradForskelVsSidsteAar !== null) {
                l += ` ${Math.abs(v.gradForskelVsSidsteAar)} grader ${v.gradForskelVsSidsteAar >= 0 ? "varmere" : "koldere"} end sidste år.`;
            }
            linjerLokal.push(l);
        }
        if (drivere && drivere.lager) {
            const lg = drivere.lager;
            let l = `Lager hos Pillemadsen: ${lg.antalPaaLager} af ${lg.antalTotal} varer på lager (${lg.andelProcent}%).`;
            const t = lg.tendens7dage;
            if (t) {
                l += ` For 7 dage siden var det ${t.varerFoer} varer (${t.pctAendring >= 0 ? "+" : ""}${t.pctAendring}%).`;
                if (t.beholdning) {
                    l += ` Samlet lagerbeholdning er gået fra ${t.beholdning.sumFoer} til ${t.beholdning.sumNu} paller (${t.beholdning.pctAendring >= 0 ? "+" : ""}${t.beholdning.pctAendring}%).`;
                }
                if (t.stoersteFald && t.stoersteFald.length) {
                    l += ` Størst fald: ` + t.stoersteFald.map(f => `${f.maerke} fra ${f.fra} til ${f.til}`).join(", ") + ".";
                }
                if (t.maerkerGaaetUdsolgt.length) {
                    l += ` Gået helt udsolgt: ${t.maerkerGaaetUdsolgt.join(", ")}.`;
                }
            }
            if (udsolgteMaerker.length) l += ` Helt udsolgte mærker: ${udsolgteMaerker.join(", ")}.`;
            l += ` VIGTIGT: lagerbevægelser indgår ikke i vurderingen. Vi har endnu ikke set en hel fyringssæson,`
               + ` så vi ved ikke, om faldende lager varsler prisstigninger. Beskriv gerne hvad lageret gør,`
               + ` men brug det ikke som begrundelse for en prisretning.`;
            linjerLokal.push(l);
        }
        // Billigste pris FØRST: det er den, brugeren faktisk køber til, og den,
        // Overblik og prisalarmen viser. Sendes kun gennemsnittet, kommer AI'en
        // til at nævne et tal, der ikke står nogen andre steder i appen.
        linjerLokal.push(`Priser hos Pillemadsen: billigste vare på lager ${dagensOpsummering.billigstePaaLager ?? "ukendt"} kr/kg. ` +
            `Gennemsnit af varer på lager: 6 mm ${dagensOpsummering.gnsPris6mmPaaLager ?? "ukendt"} kr/kg, 8 mm ${dagensOpsummering.gnsPris8mmPaaLager ?? "ukendt"} kr/kg. ` +
            `Brug billigste pris, når du nævner hvad piller koster.`);
        // Dansk elpris er FJERNET som driver. DK1-spot er reelt en aflæsning af,
        // hvor meget det blæser i Jylland - og vejret måler vi allerede direkte.
        // Desuden udgør afgifter og tariffer det meste af en husholdnings elregning,
        // så en fordobling af spot flytter kun den leverede pris nogle få procent.
        // Den står nu under BAGGRUND, hvor AI'en ikke må bruge den som forklaring.
        if (drivere && drivere.elprisDK && drivere.elprisDK.snitSeneste7DageKrKwh !== null) {
            const e = drivere.elprisDK;
            linjerBaggrund.push(`Dansk elpris DK1 (day-ahead, kun til orientering): ${e.snitSeneste7DageKrKwh} kr/kWh seneste 7 dage.`);
        }
        const linjerTransport = [];
        if (drivere && drivere.diesel && drivere.diesel.dieselDKEurPrLiter !== null) {
            const d = drivere.diesel;
            let l = `Dieselpris i Danmark: ${d.dieselDKEurPrLiter} EUR/liter inkl. afgifter`;
            if (d.dieselDEEurPrLiter !== null) l += ` (Tyskland: ${d.dieselDEEurPrLiter} EUR/liter)`;
            if (d.pctAendring30dage !== null) l += `. ${d.pctAendring30dage >= 0 ? "+" : ""}${d.pctAendring30dage}% siden ${d.sammenlignDato} - ${d.retning}.`;
            else l += ".";
            linjerTransport.push(l);
        }

        let kontekst = "DET TYSKE MARKED (den underliggende prisretning):\n" + linjerDE.join("\n") +
            "\n\nPILLEMADSEN / GRÆNSEHANDEL (det marked brugeren køber i):\n" + linjerLokal.join("\n");
        if (linjerTransport.length) {
            kontekst += "\n\nTRANSPORT (påvirker brugerens leverede pris, ikke hyldeprisen):\n" + linjerTransport.join("\n");
        }
        if (linjerBaggrund.length) {
            kontekst += "\n\nBAGGRUND - MÅ IKKE BRUGES SOM FORKLARING PÅ PRISEN:\n" + linjerBaggrund.join("\n") +
                "\nElpriser svinger med vind og sol og siger intet om udbud og efterspørgsel på træpiller. " +
                "Nævn dem ikke i din tekst.";
        }

        // Vurderingen er allerede regnet af signalmotoren. AI'en får den som en
        // given konklusion og skal forklare den - ikke danne sin egen. Ellers
        // kan teksten på Marked-skærmen komme til at modsige måleren på Overblik.
        let vurderingBlok = "";
        if (signaler) {
            const k = signaler.koebsvurdering;
            vurderingBlok =
                "\n\nFÆRDIG VURDERING (beregnet af systemet - du skal forklare den, ikke ændre den):\n" +
                `Købsvurdering: ${k.overskrift}. Begrundelse: ${k.begrundelse}\n` +
                `Prognose ${signaler.prognose.horisont}: ${signaler.prognose.retning}. ${signaler.prognose.tekst}\n` +
                (signaler.marked.alderDage !== null
                    ? `Bemærk: DEPI-tallet er fra ${signaler.marked.dataDato} og ca. ${signaler.marked.alderDage} dage gammelt.\n`
                    : "") +
                "Signaler der bevidst IKKE tæller med endnu: " +
                (signaler.signaler.filter(s => !s.aktiv).map(s => s.navn).join(", ") || "ingen") + ".";
        }

        const systemPrompt =
            "Du er en kort, nøgtern markedsanalytiker for træpiller. Brugeren køber træpiller hos Pillemadsen " +
            "i Harrislee lige syd for den dansk-tyske grænse, med 7% tysk moms, og får dem hentet hjem af en " +
            "dansk vognmand. De fleste af Pillemadsens kunder er danske. " +
            "Svar altid på dansk i almindelig løbende tekst - ingen markdown, overskrifter, punktopstilling eller emojis. " +
            "Brug kun de tal, du får oplyst. Opfind aldrig nye tal eller kilder. " +
            "VIGTIGT: Købsvurderingen og prognoseretningen er allerede afgjort af systemet. Din opgave er at " +
            "forklare dem i almindeligt dansk ud fra måletallene. Du må ikke nå frem til en anden konklusion, " +
            "og du må ikke selv vurdere, om prisen er på vej op eller ned, ud over det du har fået oplyst. " +
            "Hvis et signal er markeret som ikke-tællende, må du ikke bruge det som begrundelse. " +
            "Forklar ALDRIG træpillepriser med elpriser. Elprisen i DK1 følger vind og sol og siger intet om " +
            "udbud og efterspørgsel på træpiller. " +
            "Rolig og faktuel tone, ingen finansiel rådgivning.";

        const userPrompt =
            "Dagens måletal:\n\n" + kontekst + vurderingBlok + "\n\n" +
            "Sådan hænger tingene typisk sammen: Koldt vejr i TYSKLAND øger det samlede tyske varmebehov og " +
            "presser hele markedets pris op. Koldt vejr i DANMARK øger derimod især efterspørgslen hos " +
            "Pillemadsen, fordi kunderne er danske - det tømmer deres lager hurtigere, uden at det tyske " +
            "marked nødvendigvis flytter sig. Faldende lagerbeholdning er derfor et tidligt lokalt varsel. " +
            "Stigende energipriser trækker produktionsomkostningerne op. Høj tysk pelletproduktion betyder god " +
            "forsyning og dæmper prisen; lav produktion strammer markedet. Polens statstilskud til pilleovne " +
            "fra 2025 har reduceret polsk eksport til det tyske marked.\n\n" +
            "Brugeren får pillerne hentet hjem af en dansk vognmand, så dieselprisen påvirker den samlede " +
            "leverede pris - også selvom Pillemadsens hyldepris ikke ændrer sig. Nævn kun diesel, hvis den " +
            "har flyttet sig mærkbart.\n\n" +
            "Skriv tre korte adskilte afsnit på dansk, adskilt af en tom linje, i denne rækkefølge:\n" +
            "1) Det tyske marked. Nævn her selv, at DEPI-tallet er nogle uger gammelt og beskriver retningen, " +
            "ikke dagens pris.\n" +
            "2) Pillemadsen og grænsehandlen - det marked brugeren faktisk køber i.\n" +
            "3) Hvad det betyder for de kommende " + (signaler ? signaler.prognose.horisont : "2-4 uger") + ", " +
            "sluttende med den købsvurdering du har fået oplyst, formuleret med brugerens egne ord.\n\n" +
            "Højst tre sætninger pr. afsnit. Nævn kun drivere, der faktisk peger i en retning, og spring de " +
            "neutrale over. Udtal dig ikke om mere end nogle få uger frem.";

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.4,
                max_tokens: 400
            })
        });

        if (!res.ok) {
            // Falder tilbage til en mindre model. Den er lidt kortere i spyttet,
            // men bedre end slet ingen markedsanalyse, hvis hovedmodellen er
            // optaget eller minutkvoten er opbrugt.
            console.warn("Hovedmodellen svarede " + res.status + " - forsøger med mindre model.");
            const reserveRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + apiKey
                },
                body: JSON.stringify({
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt }
                    ],
                    temperature: 0.4,
                    max_tokens: 400
                })
            });
            if (!reserveRes.ok) throw new Error("Groq API svarede med status " + res.status + " (og reserve: " + reserveRes.status + ")");
            const reserveJson = await reserveRes.json();
            const reserveTekst = reserveJson.choices && reserveJson.choices[0] && reserveJson.choices[0].message && reserveJson.choices[0].message.content;
            if (!reserveTekst) throw new Error("Intet svar-indhold fra reservemodellen");
            fs.writeFileSync("ai-analyse.json", JSON.stringify({
                genereretUTC: new Date().toISOString(),
                genereretDanskTid: danskTid(),
                tekst: reserveTekst.trim()
            }, null, 2), "utf8");
            console.log("Markedsanalyse gemt (reservemodel).");
            return;
        }
        const json = await res.json();
        const tekst = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
        if (!tekst) throw new Error("Intet svar-indhold fra AI'en");

        fs.writeFileSync("ai-analyse.json", JSON.stringify({
            genereretUTC: new Date().toISOString(),
            genereretDanskTid: danskTid(),
            tekst: tekst.trim()
        }, null, 2), "utf8");
        console.log("Markedsanalyse gemt.");
    } catch (err) {
        console.warn("Kunne ikke hente AI-analyse (springer over):", err.message);
    }
}

const webpush = require("web-push");
const { GoogleAuth } = require("google-auth-library");

// Den offentlige VAPID-nøgle er IKKE hemmelig - den skal netop deles med browseren.
// Kun den private nøgle er hemmelig og hentes fra en GitHub Secret.
const VAPID_PUBLIC_KEY = "BNsOC00BEuHqjo7vy39nm2qfjET9cOuXljmXp9J-Xi3yLPJPfVKFwzyAm0dv7gd32Mw1nNGfknL9-izYPIumUxk";
const FIRESTORE_SAMLING = "push-abonnementer";

// Henter alle tilmeldte enheder fra Firestore. Appen skriver dem selv derind,
// så hverken du eller familien skal røre GitHub for at tilmelde sig.
async function hentAbonnenterFraFirestore() {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!serviceAccountJson) {
        console.warn("Ingen FIREBASE_SERVICE_ACCOUNT sat - springer push-alarmer over.");
        return null;
    }
    const credentials = JSON.parse(serviceAccountJson);
    const projectId = credentials.project_id;

    const auth = new GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/datastore"]
    });
    const client = await auth.getClient();
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${FIRESTORE_SAMLING}`;
    const res = await client.request({ url });

    const dokumenter = (res.data && res.data.documents) || [];
    return {
        projectId,
        client,
        abonnenter: dokumenter.map(doc => {
            const f = doc.fields || {};
            const tal = v => (v && (v.doubleValue !== undefined ? v.doubleValue : Number(v.integerValue)));
            return {
                docNavn: doc.name,
                graense: tal(f.graense),
                vagtMaerker: (f.vagtMaerker && f.vagtMaerker.arrayValue && f.vagtMaerker.arrayValue.values
                    ? f.vagtMaerker.arrayValue.values.map(v => v.stringValue).filter(Boolean)
                    : []),
                subscription: {
                    endpoint: f.endpoint && f.endpoint.stringValue,
                    keys: {
                        p256dh: f.p256dh && f.p256dh.stringValue,
                        auth: f.auth && f.auth.stringValue
                    }
                }
            };
        }).filter(a => a.subscription.endpoint &&
            (typeof a.graense === "number" || a.vagtMaerker.length))
    };
}


// Sender besked, når et mærke går fra udsolgt til på lager igen. Vi sender kun
// på selve OVERGANGEN - ellers ville man få den samme besked hver dag, så længe
// varen stod på lager. Afkrydsningen bliver stående, så vagten virker igen næste
// gang mærket bliver udsolgt.
function findGenkomneMaerker(produkter) {
    let historik;
    try { historik = JSON.parse(fs.readFileSync("lager-historik.json", "utf8")); }
    catch (e) { return []; }
    if (!Array.isArray(historik) || historik.length < 2) return [];

    const iGaar = historik[historik.length - 2];
    if (!iGaar || !Array.isArray(iGaar.varer)) return [];

    // Et mærke tæller som udsolgt, når INGEN af mærkets varer var på lager.
    const paaLagerIGaar = new Set(iGaar.varer.map(v => v.maerke).filter(Boolean));
    const paaLagerIDag = new Set(produkter.filter(p => p.paaLager === true).map(p => p.maerke).filter(Boolean));
    const genkomne = [];
    for (const maerke of paaLagerIDag) {
        // Var mærket kendt i går uden at være på lager? Så er det kommet tilbage.
        if (!paaLagerIGaar.has(maerke)) genkomne.push(maerke);
    }
    return genkomne;
}

async function sendPushLagerVarsler(produkter) {
    const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
    if (!privateKey) return;

    const genkomne = findGenkomneMaerker(produkter);
    if (!genkomne.length) { console.log("Ingen mærker er kommet på lager igen i dag."); return; }
    console.log("Kommet på lager igen:", genkomne.join(", "));

    let data;
    try { data = await hentAbonnenterFraFirestore(); }
    catch (err) { console.warn("Kunne ikke hente abonnenter (springer lagervarsler over):", err.message); return; }
    if (!data || !data.abonnenter.length) return;

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, privateKey);
    let sendt = 0;

    for (const ab of data.abonnenter) {
        const traef = genkomne.filter(m => ab.vagtMaerker.includes(m));
        if (!traef.length) continue;

        // Pris med, hvis vi har den - så kan man se, om det overhovedet er værd at handle på.
        const priser = traef.map(m => {
            const varer = produkter.filter(p => p.maerke === m && p.paaLager === true && p.prisPrKg !== null);
            if (!varer.length) return m;
            return m + " (" + Math.min(...varer.map(p => p.prisPrKg)).toFixed(2).replace(".", ",") + " kr/kg)";
        });

        const payload = JSON.stringify({
            titel: traef.length === 1 ? traef[0] + " er på lager igen" : "Flere mærker er på lager igen",
            tekst: priser.join(", ") + " er tilbage hos Pillemadsen.",
            url: "./index.html"
        });
        try {
            await webpush.sendNotification(ab.subscription, payload);
            sendt++;
        } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
                try { await data.client.request({ url: `https://firestore.googleapis.com/v1/${ab.docNavn}`, method: "DELETE" }); }
                catch (e) { /* ikke kritisk */ }
            } else {
                console.warn("Kunne ikke sende lagervarsel:", err.message);
            }
        }
    }
    console.log("Lagervarsler sendt til " + sendt + " enhed(er).");
}

// Sender en rigtig push-besked til hver tilmeldt enhed, hvis billigste pris på
// lager er faldet til eller under deres grænse. Fejler dette, springes det
// stille over - det må aldrig vælte selve prisopdateringen.
async function sendPushAlarmer(produkter) {
    const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
    if (!privateKey) {
        console.warn("Ingen PUSH_VAPID_PRIVATE_KEY sat - springer push-alarmer over.");
        return;
    }

    let data;
    try {
        data = await hentAbonnenterFraFirestore();
    } catch (err) {
        console.warn("Kunne ikke hente abonnenter fra Firestore (springer over):", err.message);
        return;
    }
    if (!data) return;
    if (!data.abonnenter.length) {
        console.log("Ingen tilmeldte enheder endnu.");
        return;
    }

    const medPris = produkter.filter(p => p.paaLager === true && p.prisPrKg !== null);
    const billigste = medPris.slice().sort((a, b) => a.prisPrKg - b.prisPrKg)[0];
    if (!billigste) {
        console.log("Ingen varer på lager med pris - springer push-alarmer over.");
        return;
    }

    webpush.setVapidDetails("mailto:traepillerdk@example.com", VAPID_PUBLIC_KEY, privateKey);

    let sendt = 0, ryddet = 0;
    for (const ab of data.abonnenter) {
        if (typeof ab.graense !== "number" || billigste.prisPrKg > ab.graense) continue;
        const payload = JSON.stringify({
            titel: "Prisalarm: " + billigste.maerke,
            tekst: billigste.maerke + " er nede på " + billigste.prisPrKg.toFixed(2) +
                " kr/kg (din grænse: " + ab.graense.toFixed(2) + " kr/kg)",
            url: "./index.html"
        });
        try {
            await webpush.sendNotification(ab.subscription, payload);
            sendt++;
        } catch (err) {
            // 404/410 betyder at enheden har afmeldt sig - så rydder vi op i Firestore
            if (err.statusCode === 404 || err.statusCode === 410) {
                try {
                    await data.client.request({
                        url: `https://firestore.googleapis.com/v1/${ab.docNavn}`,
                        method: "DELETE"
                    });
                    ryddet++;
                } catch (e) { /* ikke kritisk */ }
            } else {
                console.warn("Kunne ikke sende push til en enhed:", err.message);
            }
        }
    }
    console.log("Push sendt til " + sendt + " enhed(er)." + (ryddet ? " Ryddede " + ryddet + " udløbne." : ""));
}

// ---------------------------------------------------------------------------
// DRIVERE: rigtige tal for de forhold, der påvirker træpillemarkedet.
// Alle kilder er gratis og kræver ingen API-nøgle.
// ---------------------------------------------------------------------------

// To vejrpunkter: dansk vejr driver Pillemadsens lokale efterspørgsel (de fleste
// kunder er danske), mens tysk vejr driver det underliggende tyske pelletmarked.
const VEJR_DK = { bredde: 55.97, laengde: 10.15, navn: "Østjylland" };
const VEJR_DE = { bredde: 51.16, laengde: 10.45, navn: "Midttyskland" };
const VARMEGRAENSE = 17; // °C - under denne temperatur regnes der med fyringsbehov

function isoDato(d) {
    return d.toISOString().slice(0, 10);
}

// Graddage er et standardmål for fyringsbehov: for hver dag lægges forskellen
// mellem 17 °C og døgnets middeltemperatur sammen. Jo flere graddage, jo koldere
// og jo større forbrug af træpiller.
function graddage(temperaturer) {
    return temperaturer
        .filter(t => typeof t === "number")
        .reduce((sum, t) => sum + Math.max(0, VARMEGRAENSE - t), 0);
}

async function hentVejrdriver(bredde, laengde, stednavn) {
    const idag = new Date();
    const om14dage = new Date(idag.getTime() + 13 * 86400000);

    const prognoseUrl = `https://api.open-meteo.com/v1/forecast?latitude=${bredde}&longitude=${laengde}` +
        `&daily=temperature_2m_mean&forecast_days=14&timezone=Europe%2FBerlin`;
    const prognoseRes = await fetch(prognoseUrl);
    if (!prognoseRes.ok) throw new Error("Open-Meteo prognose svarede " + prognoseRes.status);
    const prognose = await prognoseRes.json();
    const prognoseTemps = (prognose.daily && prognose.daily.temperature_2m_mean) || [];
    if (!prognoseTemps.length) throw new Error("Ingen temperaturer i prognosen");

    // Samme kalenderperiode sidste år, som sammenligningsgrundlag
    const sidsteAarStart = new Date(idag.getTime()); sidsteAarStart.setFullYear(idag.getFullYear() - 1);
    const sidsteAarSlut = new Date(om14dage.getTime()); sidsteAarSlut.setFullYear(om14dage.getFullYear() - 1);
    const arkivUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${bredde}&longitude=${laengde}` +
        `&start_date=${isoDato(sidsteAarStart)}&end_date=${isoDato(sidsteAarSlut)}` +
        `&daily=temperature_2m_mean&timezone=Europe%2FBerlin`;
    let sidsteAarGraddage = null, sidsteAarSnit = null;
    try {
        const arkivRes = await fetch(arkivUrl);
        if (arkivRes.ok) {
            const arkiv = await arkivRes.json();
            const arkivTemps = (arkiv.daily && arkiv.daily.temperature_2m_mean) || [];
            const gyldige = arkivTemps.filter(t => typeof t === "number");
            if (gyldige.length) {
                sidsteAarGraddage = Math.round(graddage(gyldige));
                sidsteAarSnit = Math.round((gyldige.reduce((a, b) => a + b, 0) / gyldige.length) * 10) / 10;
            }
        }
    } catch (e) { /* sammenligning er valgfri */ }

    const snit = Math.round((prognoseTemps.reduce((a, b) => a + b, 0) / prognoseTemps.length) * 10) / 10;
    const gd = Math.round(graddage(prognoseTemps));

    // Om sommeren er graddagene nær nul, og så bliver procentændringer
    // meningsløse (1 graddag mod 0,3 giver +233%, uden at nogen fyrer).
    // Derfor kræves et reelt fyringsbehov, før procenten bruges - ellers
    // sammenlignes temperaturen direkte i stedet.
    const MIN_GRADDAGE_FOR_PROCENT = 40; // ca. 3 grader under 17 i 14 dage
    let retning = "ukendt", pctAendring = null, fyringssaeson = gd >= MIN_GRADDAGE_FOR_PROCENT;

    if (fyringssaeson && sidsteAarGraddage !== null && sidsteAarGraddage >= MIN_GRADDAGE_FOR_PROCENT) {
        pctAendring = Math.round(((gd - sidsteAarGraddage) / sidsteAarGraddage) * 100);
        if (pctAendring > 15) retning = "koldere";
        else if (pctAendring < -15) retning = "mildere";
        else retning = "normalt";
    } else if (sidsteAarSnit !== null) {
        // Uden for fyringssæsonen sammenlignes temperaturen direkte
        const gradForskel = Math.round((snit - sidsteAarSnit) * 10) / 10;
        if (!fyringssaeson) retning = "uden for fyringssæson";
        else if (gradForskel < -1.5) retning = "koldere";
        else if (gradForskel > 1.5) retning = "mildere";
        else retning = "normalt";
    } else if (!fyringssaeson) {
        retning = "uden for fyringssæson";
    }

    const gradForskelVsSidsteAar = sidsteAarSnit !== null
        ? Math.round((snit - sidsteAarSnit) * 10) / 10 : null;

    return {
        sted: stednavn,
        snitTemp14dage: snit,
        graddage14dage: gd,
        graddageSammeTidSidsteAar: sidsteAarGraddage,
        snitTempSidsteAar: sidsteAarSnit,
        pctAendringGraddage: pctAendring,
        gradForskelVsSidsteAar,
        fyringssaeson,
        retning,
        kilde: "Open-Meteo (DMI/ECMWF-modeller)"
    };
}

// Tysk day-ahead elpris fra Fraunhofer ISE (gratis, ingen nøgle).
// Strøm er en væsentlig omkostning i pelletproduktion (tørring, presning).
async function hentTyskElpris() {
    const idag = new Date();
    const for14dageSiden = new Date(idag.getTime() - 14 * 86400000);
    const url = "https://api.energy-charts.info/price?bzn=DE-LU" +
        `&start=${isoDato(for14dageSiden)}&end=${isoDato(idag)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Energy-Charts svarede " + res.status);
    const json = await res.json();
    const tider = json.unix_seconds || [];
    const priser = json.price || [];
    if (tider.length < 48 || priser.length !== tider.length) {
        throw new Error("For få tyske elpris-poster (" + tider.length + ")");
    }

    const midtSek = Math.floor((idag.getTime() - 7 * 86400000) / 1000);
    const seneste7 = [], forrige7 = [];
    for (let i = 0; i < tider.length; i++) {
        if (typeof priser[i] !== "number") continue;
        (tider[i] >= midtSek ? seneste7 : forrige7).push(priser[i]);
    }
    const snit = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const nu = snit(seneste7), foer = snit(forrige7);

    let pctAendring = null, retning = "ukendt";
    if (nu !== null && foer !== null && foer !== 0) {
        pctAendring = Math.round(((nu - foer) / foer) * 100);
        if (pctAendring > 10) retning = "stigende";
        else if (pctAendring < -10) retning = "faldende";
        else retning = "stabil";
    }

    return {
        snitSeneste7DageEurMwh: nu !== null ? Math.round(nu * 10) / 10 : null,
        snitForrige7DageEurMwh: foer !== null ? Math.round(foer * 10) / 10 : null,
        pctAendring,
        retning,
        kilde: "Fraunhofer ISE / Energy-Charts (DE-LU day-ahead)"
    };
}

async function hentElpriser() {
    const idag = new Date();
    const for14dageSiden = new Date(idag.getTime() - 14 * 86400000);
    // Elspotprices-datasættet blev nedlagt 30-09-2025; DayAheadPrices er efterfølgeren.
    const url = "https://api.energidataservice.dk/dataset/DayAheadPrices" +
        `?start=${isoDato(for14dageSiden)}&end=${isoDato(idag)}` +
        `&filter=${encodeURIComponent('{"PriceArea":"DK1"}')}&limit=1000`;

    const res = await fetch(url);
    if (!res.ok) throw new Error("Energi Data Service svarede " + res.status);
    const json = await res.json();

    // Feltnavnene varierer mellem datasæt-versioner, så vi tager det første, der findes
    const prisFelt = r => {
        for (const navn of ["DayAheadPriceDKK", "SpotPriceDKK", "PriceDKK"]) {
            if (typeof r[navn] === "number") return r[navn];
        }
        // Hvis kun EUR findes, omregnes med fastkursen
        for (const navn of ["DayAheadPriceEUR", "SpotPriceEUR", "PriceEUR"]) {
            if (typeof r[navn] === "number") return r[navn] * EUR_TIL_DKK;
        }
        return null;
    };
    const tidsFelt = r => r.HourDK || r.TimeDK || r.HourUTC || r.TimeUTC;

    const poster = (json.records || []).filter(r => prisFelt(r) !== null && tidsFelt(r));
    if (poster.length < 48) throw new Error("For få elpris-poster (" + poster.length + ")");

    // Priserne er kr pr. MWh - divider med 1000 for kr/kWh
    const medTid = poster.map(r => ({ tid: new Date(tidsFelt(r)), pris: prisFelt(r) / 1000 }))
        .sort((a, b) => a.tid - b.tid);
    const midt = new Date(idag.getTime() - 7 * 86400000);
    const seneste7 = medTid.filter(p => p.tid >= midt).map(p => p.pris);
    const forrige7 = medTid.filter(p => p.tid < midt).map(p => p.pris);
    const snit = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const nu = snit(seneste7), foer = snit(forrige7);
    let pctAendring = null, retning = "ukendt";
    if (nu !== null && foer !== null && foer !== 0) {
        pctAendring = Math.round(((nu - foer) / foer) * 100);
        if (pctAendring > 10) retning = "stigende";
        else if (pctAendring < -10) retning = "faldende";
        else retning = "stabil";
    }

    return {
        snitSeneste7DageKrKwh: nu !== null ? Math.round(nu * 100) / 100 : null,
        snitForrige7DageKrKwh: foer !== null ? Math.round(foer * 100) / 100 : null,
        pctAendring,
        retning,
        kilde: "Energi Data Service (elspot DK1, uden afgifter)"
    };
}

// Samler alle drivere. Hver kilde fejler for sig, så én nedbrudt kilde ikke
// vælter de øvrige - der skrives blot null for den pågældende driver.
async function hentDrivere(produkter, dagensOpsummering, lagerHistorik, browser) {
    const drivere = {
        hentetUTC: new Date().toISOString(),
        hentetDanskTid: danskTid(),
        vejrDK: null,
        vejrDE: null,
        elprisDK: null,
        elprisDE: null,
        lager: null,
        depi: null,
        produktion: null,
        diesel: null
    };

    if (browser) {
        try { drivere.diesel = await hentDieselpris(browser); }
        catch (err) { console.warn("Kunne ikke hente dieselpris:", err.message); }
    }

    try { drivere.vejrDK = await hentVejrdriver(VEJR_DK.bredde, VEJR_DK.laengde, VEJR_DK.navn); }
    catch (err) { console.warn("Kunne ikke hente dansk vejrdata:", err.message); }

    try { drivere.vejrDE = await hentVejrdriver(VEJR_DE.bredde, VEJR_DE.laengde, VEJR_DE.navn); }
    catch (err) { console.warn("Kunne ikke hente tysk vejrdata:", err.message); }

    try { drivere.elprisDK = await hentElpriser(); }
    catch (err) { console.warn("Kunne ikke hente danske elpriser:", err.message); }

    try { drivere.elprisDE = await hentTyskElpris(); }
    catch (err) { console.warn("Kunne ikke hente tyske elpriser:", err.message); }

    const paaLager = produkter.filter(p => p.paaLager === true);
    const andel = produkter.length ? paaLager.length / produkter.length : 0;
    drivere.lager = {
        antalPaaLager: paaLager.length,
        antalTotal: produkter.length,
        andelProcent: Math.round(andel * 100),
        tendens7dage: lagerTendens(lagerHistorik, 7),
        tendens30dage: lagerTendens(lagerHistorik, 30),
        retning: andel > 0.5 ? "høj" : (andel > 0.2 ? "middel" : "lav"),
        kilde: "Pillemadsen.dk"
    };

    try {
        const depiData = JSON.parse(fs.readFileSync("tysk-markedsindeks.json", "utf8"));
        const maaneder = (depiData.maaneder || []).slice().sort((a, b) => a.dato.localeCompare(b.dato));
        if (maaneder.length) {
            const seneste = maaneder[maaneder.length - 1];
            const [aar, maaned] = seneste.dato.split("-");
            const sidsteAar = maaneder.find(m => m.dato === (Number(aar) - 1) + "-" + maaned);
            // År-til-år siger noget om NIVEAU, ikke om retning. At ligge 28% over
            // sidste år betyder ikke, at prisen stiger nu - i sommeren 2026 lå den
            // højt over sidste år og faldt samtidig måned for måned. De to blev
            // tidligere blandet sammen, så konteksten sagde "stigende" om et
            // faldende marked.
            let pct = null, niveauVsSidsteAar = "ukendt", retning = "ukendt", pctSeneste2Mdr = null;
            if (sidsteAar) {
                pct = Math.round(((seneste.dkkPrKg - sidsteAar.dkkPrKg) / sidsteAar.dkkPrKg) * 100);
                if (pct > 5) niveauVsSidsteAar = "over sidste år";
                else if (pct < -5) niveauVsSidsteAar = "under sidste år";
                else niveauVsSidsteAar = "som sidste år";
            }
            // Den faktiske retning måles på de senest offentliggjorte måneder.
            if (maaneder.length >= 3) {
                const a = maaneder[maaneder.length - 3], b = maaneder[maaneder.length - 1];
                pctSeneste2Mdr = Math.round(((b.dkkPrKg - a.dkkPrKg) / a.dkkPrKg) * 1000) / 10;
                if (pctSeneste2Mdr > 1) retning = "stigende";
                else if (pctSeneste2Mdr < -1) retning = "faldende";
                else retning = "stabil";
            }
            drivere.depi = {
                dato: seneste.dato,
                dkkPrKg: seneste.dkkPrKg,
                pctAarTilAar: pct,
                niveauVsSidsteAar,
                pctSeneste2Mdr,
                retning,
                kilde: "Deutsches Pelletinstitut (DEPI)"
            };
        }
    } catch (e) { /* DEPI-driver er valgfri */ }

    try {
        const prodData = JSON.parse(fs.readFileSync("tysk-produktion.json", "utf8"));
        const kvartaler = (prodData.kvartaler || []).slice().sort((a, b) => a.kvartal.localeCompare(b.kvartal));
        if (kvartaler.length) {
            const seneste = kvartaler[kvartaler.length - 1];
            const forrige = kvartaler.length > 1 ? kvartaler[kvartaler.length - 2] : null;
            // Samme kvartal året før, hvis vi har det
            const [pAar, pKv] = seneste.kvartal.split("-");
            const sammeKvSidsteAar = kvartaler.find(k => k.kvartal === (Number(pAar) - 1) + "-" + pKv);

            let pctKvartal = null, pctAar = null, retning = "ukendt";
            if (forrige && forrige.produktionTon) {
                pctKvartal = Math.round(((seneste.produktionTon - forrige.produktionTon) / forrige.produktionTon) * 100);
            }
            if (sammeKvSidsteAar && sammeKvSidsteAar.produktionTon) {
                pctAar = Math.round(((seneste.produktionTon - sammeKvSidsteAar.produktionTon) / sammeKvSidsteAar.produktionTon) * 100);
            }
            // Stigende produktion = bedre forsyning = nedadgående prispres
            const maalePct = pctAar !== null ? pctAar : pctKvartal;
            if (maalePct !== null) {
                if (maalePct > 3) retning = "høj";
                else if (maalePct < -3) retning = "lav";
                else retning = "stabil";
            }

            drivere.produktion = {
                kvartal: seneste.kvartal,
                produktionTon: seneste.produktionTon,
                pctVsForrigeKvartal: pctKvartal,
                pctVsSammeKvartalSidsteAar: pctAar,
                saegerestholzProcent: seneste.saegerestholzProcent,
                eksportProcent: seneste.eksportProcent,
                retning,
                kilde: "Deutsches Pelletinstitut (DEPI)"
            };
        }
    } catch (e) { /* produktionsdriver er valgfri */ }

    fs.writeFileSync("drivere.json", JSON.stringify(drivere, null, 2), "utf8");
    console.log("Drivere gemt.");
    return drivere;
}

// Gemmer et dagligt øjebliksbillede af lagerbeholdning og pris pr. produkt.
// Pillemadsen afrunder store beholdninger til "50+" og "100+", så tallene er
// grove i toppen - men et fald fra 100+ til fx 12 er et tydeligt signal, og
// det er netop de fald, der kommer før en prisstigning.
function opdaterLagerHistorik(produkter, dato) {
    let historik = [];
    try {
        const eksisterende = JSON.parse(fs.readFileSync("lager-historik.json", "utf8"));
        if (Array.isArray(eksisterende)) historik = eksisterende;
    } catch (e) {
        historik = [];
    }

    const paaLager = produkter.filter(p => p.paaLager === true);
    const dagensPost = {
        dato,
        antalPaaLager: paaLager.length,
        antalTotal: produkter.length,
        varer: paaLager.map(p => ({
            produkt: p.produkt,
            maerke: p.maerke,
            prisPrKg: p.prisPrKg,
            antal: typeof p.antalPaaLager === "number" ? p.antalPaaLager : null,
            antalErMindst: Boolean(p.antalErMindst)
        }))
    };

    const idx = historik.findIndex(h => h.dato === dato);
    if (idx >= 0) historik[idx] = dagensPost;
    else historik.push(dagensPost);
    historik.sort((a, b) => a.dato.localeCompare(b.dato));

    // Behold ca. et år, så filen ikke vokser i det uendelige
    if (historik.length > 400) historik = historik.slice(historik.length - 400);

    fs.writeFileSync("lager-historik.json", JSON.stringify(historik, null, 2), "utf8");
    const medAntal = dagensPost.varer.filter(v => v.antal !== null).length;
    console.log("Lagerhistorik har nu " + historik.length + " dag(e) med data (" +
        dagensPost.antalPaaLager + " af " + dagensPost.antalTotal + " varer på lager, " +
        medAntal + " med beholdningstal).");
    return historik;
}

// Beregner udviklingen i ANTAL VARER på lager over de seneste dage.
function lagerTendens(lagerHistorik, dage) {
    if (!Array.isArray(lagerHistorik) || lagerHistorik.length < 2) return null;
    const sidste = lagerHistorik[lagerHistorik.length - 1];
    const maalDato = new Date(new Date(sidste.dato).getTime() - dage * 86400000).toISOString().slice(0, 10);
    // Find den ældste post, der ikke er ældre end målperioden
    const tidligere = lagerHistorik.filter(h => h.dato <= maalDato).pop() || lagerHistorik[0];
    if (tidligere.dato === sidste.dato) return null;

    const antalVarer = post => (typeof post.antalPaaLager === "number" ? post.antalPaaLager : post.varer.length);
    const nu = antalVarer(sidste), foer = antalVarer(tidligere);
    if (foer === 0) return null;

    // Hvilke mærker er røget af lager i perioden?
    const foerMaerker = new Set(tidligere.varer.map(v => v.maerke));
    const nuMaerker = new Set(sidste.varer.map(v => v.maerke));
    const forsvundne = Array.from(foerMaerker).filter(m => !nuMaerker.has(m));

    // Samlet beholdning, hvor vi har tal. Bemærk at "50+" tælles som 50, så
    // summen er et minimum - den kan ikke bruges til at måle stigninger i
    // toppen, men et fald er reelt.
    const sumBeholdning = post => {
        const med = post.varer.filter(v => typeof v.antal === "number");
        return med.length ? { sum: med.reduce((s, v) => s + v.antal, 0), varer: med.length } : null;
    };
    const behNu = sumBeholdning(sidste), behFoer = sumBeholdning(tidligere);
    let beholdning = null;
    if (behNu && behFoer && behFoer.sum > 0) {
        beholdning = {
            sumNu: behNu.sum,
            sumFoer: behFoer.sum,
            pctAendring: Math.round(((behNu.sum - behFoer.sum) / behFoer.sum) * 100),
            varerMedTal: behNu.varer
        };
    }

    // Enkeltvarer med markant fald - det stærkeste tidlige signal
    const stoersteFald = [];
    for (const foerVare of tidligere.varer) {
        if (typeof foerVare.antal !== "number" || foerVare.antal <= 0) continue;
        const nuVare = sidste.varer.find(v => v.produkt === foerVare.produkt);
        const nuAntal = nuVare && typeof nuVare.antal === "number" ? nuVare.antal : 0;
        const pct = Math.round(((nuAntal - foerVare.antal) / foerVare.antal) * 100);
        if (pct <= -25) {
            stoersteFald.push({ produkt: foerVare.produkt, maerke: foerVare.maerke, fra: foerVare.antal, til: nuAntal, pctAendring: pct });
        }
    }
    stoersteFald.sort((a, b) => a.pctAendring - b.pctAendring);

    return {
        fraDato: tidligere.dato,
        tilDato: sidste.dato,
        varerNu: nu,
        varerFoer: foer,
        pctAendring: Math.round(((nu - foer) / foer) * 100),
        maerkerGaaetUdsolgt: forsvundne,
        beholdning,
        stoersteFald: stoersteFald.slice(0, 3)
    };
}

const TYSKE_KVARTALER = { "ersten": 1, "zweiten": 2, "dritten": 3, "vierten": 4 };

// DEPI offentliggør hvert kvartal, hvor mange ton pellets der faktisk produceres
// i Tyskland, samt hvor råmaterialet kommer fra. Høj produktion betyder god
// forsyning og dermed nedadgående prispres. Tallene ændrer sig kun 4 gange om
// året, men gemmes som historik, så vi kan se udviklingen.
async function hentTyskProduktion(browser) {
    const page = await browser.newPage({ locale: "de-DE" });
    try {
        await page.goto("https://www.depi.de/mediathek/", { waitUntil: "networkidle", timeout: 60000 });
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="/mediathek/d/"]'))
                .map(a => ({ href: a.getAttribute("href"), tekst: (a.textContent || "").toLowerCase() }))
                .filter(l => l.href && l.tekst.includes("pelletproduktion"));
        });
        if (!links.length) throw new Error("Fandt ingen artikler om pelletproduktion på DEPI");

        const url = new URL(links[0].href, "https://www.depi.de/").toString();
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        const tekst = (await page.locator("body").textContent().catch(() => "")) || "";

        const kvartalMatch = tekst.match(/Im\s+(ersten|zweiten|dritten|vierten)\s+Quartal\s+(20\d{2})/i);
        if (!kvartalMatch) throw new Error("Kunne ikke læse kvartal fra DEPI-artiklen: " + url);
        const kvartalNr = TYSKE_KVARTALER[kvartalMatch[1].toLowerCase()];
        const aar = kvartalMatch[2];
        const kvartal = aar + "-Q" + kvartalNr;

        // "rund 1.034.000 Tonnen" - tyske tusindtalsseparatorer er punktummer
        const tonMatch = tekst.match(/rund\s+([\d.]+)\s*Tonnen/i);
        if (!tonMatch) throw new Error("Kunne ikke læse produktionsmængde fra DEPI-artiklen");
        const produktionTon = Number(tonMatch[1].replace(/\./g, ""));

        const tyskProcent = m => (m ? Number(m[1].replace(",", ".")) : null);
        const saegerest = tyskProcent(tekst.match(/Sägerestholz[^%\d]*?([\d,]+)\s*Prozent/i));
        const eksport = tyskProcent(tekst.match(/Exportanteil[^%\d]*?([\d,]+)\s*Prozent/i));
        const sackware = tyskProcent(tekst.match(/Anteil der Sackware beträgt\s*([\d,]+)\s*Prozent/i));

        const nytPunkt = {
            kvartal,
            produktionTon,
            saegerestholzProcent: saegerest,
            eksportProcent: eksport,
            sackwareProcent: sackware,
            kilde: url
        };

        let data;
        try {
            data = JSON.parse(fs.readFileSync("tysk-produktion.json", "utf8"));
        } catch (e) {
            data = { kilde: "Deutsches Pelletinstitut (DEPI)", kvartaler: [] };
        }
        if (!Array.isArray(data.kvartaler)) data.kvartaler = [];

        const idx = data.kvartaler.findIndex(k => k.kvartal === kvartal);
        if (idx >= 0) data.kvartaler[idx] = nytPunkt;
        else data.kvartaler.push(nytPunkt);
        data.kvartaler.sort((a, b) => a.kvartal.localeCompare(b.kvartal));

        fs.writeFileSync("tysk-produktion.json", JSON.stringify(data, null, 2), "utf8");
        console.log("Tysk produktion opdateret for " + kvartal + " -> " + produktionTon.toLocaleString("da-DK") + " t");
    } catch (err) {
        console.warn("Kunne ikke opdatere tysk produktion (springer over):", err.message);
    } finally {
        await page.close();
    }
}

const XLSX = require("xlsx");

// EU-Kommissionens Weekly Oil Bulletin offentliggør hver torsdag brændstofpriser
// for alle EU-lande. Diesel er relevant, fordi vognmanden skal køre pillerne hjem
// fra Harrislee - det påvirker DIN leverede pris, ikke Pillemadsens hyldepris.
// Filen findes bag et stabilt link, der altid peger på nyeste udgave.
function findDieselPrisIArk(arbejdsbog, landNavn) {
    for (const arkNavn of arbejdsbog.SheetNames) {
        const raekker = XLSX.utils.sheet_to_json(arbejdsbog.Sheets[arkNavn], { header: 1, blankrows: false });

        // Find diesel-kolonnen ud fra overskriften, ikke en fast position
        let dieselKol = -1;
        for (const raekke of raekker) {
            for (let i = 0; i < raekke.length; i++) {
                const celle = String(raekke[i] || "").toLowerCase();
                if (/diesel|gas\s*oil\s*automo|gasoil\s*automo/.test(celle) && !/heating/.test(celle)) {
                    dieselKol = i; break;
                }
            }
            if (dieselKol >= 0) break;
        }
        if (dieselKol < 0) continue;

        for (const raekke of raekker) {
            const foerste = String(raekke[0] || "").trim().toLowerCase();
            if (foerste === landNavn.toLowerCase() || foerste.startsWith(landNavn.toLowerCase())) {
                const vaerdi = raekke[dieselKol];
                if (typeof vaerdi === "number" && vaerdi > 0) return vaerdi;
            }
        }
    }
    return null;
}

async function hentDieselpris(browser) {
    const page = await browser.newPage({ locale: "en-GB" });
    let filUrl = null;
    try {
        await page.goto("https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en",
            { waitUntil: "networkidle", timeout: 60000 });
        filUrl = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="/document/download/"]'));
            const medTaxes = links.find(a => /with[%\s]*20?taxes/i.test(a.getAttribute("href") || ""));
            return medTaxes ? medTaxes.href : null;
        });
    } finally {
        await page.close();
    }
    if (!filUrl) throw new Error("Fandt ikke download-link til Oil Bulletin");

    const res = await fetch(filUrl);
    if (!res.ok) throw new Error("Oil Bulletin-fil svarede " + res.status);
    const buffer = Buffer.from(await res.arrayBuffer());
    const arbejdsbog = XLSX.read(buffer, { type: "buffer" });

    // Priser er typisk pr. 1000 liter i EUR
    const dkPr1000L = findDieselPrisIArk(arbejdsbog, "Denmark");
    const dePr1000L = findDieselPrisIArk(arbejdsbog, "Germany");
    if (dkPr1000L === null && dePr1000L === null) {
        throw new Error("Kunne ikke finde dieselpriser for Danmark eller Tyskland i filen");
    }

    const nytPunkt = {
        dato: danskDato(),
        dieselDKEurPrLiter: dkPr1000L !== null ? Math.round((dkPr1000L / 1000) * 1000) / 1000 : null,
        dieselDEEurPrLiter: dePr1000L !== null ? Math.round((dePr1000L / 1000) * 1000) / 1000 : null,
        kilde: filUrl
    };

    // Gem historik, så vi selv kan beregne udviklingen over tid
    let data;
    try {
        data = JSON.parse(fs.readFileSync("diesel-historik.json", "utf8"));
    } catch (e) {
        data = { kilde: "EU-Kommissionen, Weekly Oil Bulletin (priser inkl. afgifter)", maalinger: [] };
    }
    if (!Array.isArray(data.maalinger)) data.maalinger = [];

    const idx = data.maalinger.findIndex(m => m.dato === nytPunkt.dato);
    if (idx >= 0) data.maalinger[idx] = nytPunkt;
    else data.maalinger.push(nytPunkt);
    data.maalinger.sort((a, b) => a.dato.localeCompare(b.dato));
    if (data.maalinger.length > 400) data.maalinger = data.maalinger.slice(data.maalinger.length - 400);
    fs.writeFileSync("diesel-historik.json", JSON.stringify(data, null, 2), "utf8");

    // Beregn ændring over ca. 30 dage
    let pctAendring = null, retning = "ukendt", sammenlignDato = null;
    const maalDato = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const tidligere = data.maalinger.filter(m => m.dato <= maalDato && m.dieselDKEurPrLiter !== null).pop();
    if (tidligere && nytPunkt.dieselDKEurPrLiter !== null && tidligere.dieselDKEurPrLiter > 0) {
        pctAendring = Math.round(((nytPunkt.dieselDKEurPrLiter - tidligere.dieselDKEurPrLiter) / tidligere.dieselDKEurPrLiter) * 100);
        sammenlignDato = tidligere.dato;
        // Diesel svinger langsomt - først ved større udsving er det værd at reagere på
        if (pctAendring > 5) retning = "stigende";
        else if (pctAendring < -5) retning = "faldende";
        else retning = "stabil";
    }

    console.log("Dieselpris hentet: DK " + nytPunkt.dieselDKEurPrLiter + " EUR/l, DE " + nytPunkt.dieselDEEurPrLiter + " EUR/l");
    return { ...nytPunkt, pctAendring30dage: pctAendring, sammenlignDato, retning };
}

async function hentPriser() {
    console.log("Starter browseren...");
    const browser = await chromium.launch({ headless: true });

    const kategoriData = await findKategoriProdukter(browser);
    console.log("Fandt " + kategoriData.size + " produkter på oversigtssiderne. Henter specifikationer for hvert...");

    const produkter = [];
    for (const [url, tekst] of kategoriData) {
        const linjer = tekst.split("\n").map(l => l.trim()).filter(Boolean);
        const navn = linjer[0] || "";
        if (!navn) continue;

        const prisMatch = tekst.match(/(\d[\d.]*,\d{2})\s*DKK\s*pr\.?\s*kg/i);
        const prisPrKg = prisMatch ? tal(prisMatch[1].replace(/\./g, "")) : null;

        // Pallepris: første DKK-beløb, når kilo-prisen er fjernet fra teksten
        const udenKgPris = tekst.replace(/\d[\d.]*,\d{2}\s*DKK\s*pr\.?\s*kg/gi, " ");
        const palleMatch = udenKgPris.match(/(\d[\d.]*,\d{2})\s*DKK/i);
        const prisPrPalle = palleMatch ? tal(palleMatch[1].replace(/\./g, "")) : null;
        const forlaengetLevering = /forlænget\s*lev/i.test(tekst);
        const paaLager = /ikke\s*på\s*lager/i.test(tekst) ? false
            : (forlaengetLevering ? false : (/på\s*lager/i.test(tekst) ? true : null));

        let specs = {};
        try {
            specs = await laesSpecsForProdukt(browser, url);
        } catch (err) {
            console.warn("Sprang specs over for " + url + ": " + err.message);
        }

        produkter.push({
            produkt: navn,
            maerke: maerkeFraNavn(navn),
            type: typeFraNavn(navn),
            mm: mmFraNavn(navn),
            prisPrKg,
            prisPrPalle,
            kgPrPalle: kgPrPalleFraNavn(navn),
            paaLager,
            forlaengetLevering,
            antalPaaLager: null,
            antalErMindst: false,
            ...specs,
            kilde: url
        });    }

    await browser.close();

    if (produkter.length < 5) {
        throw new Error("Kunne ikke læse produkter fra pillemadsen.dk (fik " + produkter.length +
            "). Beholder den eksisterende traepriser.json.");
    }

    const resultat = {
        hentetUTC: new Date().toISOString(),
        hentetDanskTid: danskTid(),
        hjemmeside: START_URL,
        antalProdukter: produkter.length,
        priser: produkter
    };
    fs.writeFileSync("traepriser.json", JSON.stringify(resultat, null, 2), "utf8");

    const dagensOpsummering = beregnDagligOpsummering(produkter, danskDato(), resultat.hentetDanskTid);
    const historik = opdaterHistorik(dagensOpsummering);
    const lagerHistorik = opdaterLagerHistorik(produkter, danskDato());

    console.log("\nFærdig. Antal produkter:", produkter.length, "| Tid:", resultat.hentetDanskTid);
    console.log("Historik har nu", historik.length, "dag(e) med data.");

    await sendPushAlarmer(produkter);
    try { await sendPushLagerVarsler(produkter); }
    catch (err) { console.warn("Lagervarsler fejlede (springer over):", err.message); }

    const browser2 = await chromium.launch({ headless: true });
    await hentTyskMarkedsindeks(browser2);
    await hentTyskProduktion(browser2);

    let drivere = null;
    try {
        drivere = await hentDrivere(produkter, dagensOpsummering, lagerHistorik, browser2);
    } catch (err) {
        console.warn("Kunne ikke samle drivere (springer over):", err.message);
    }
    await browser2.close();

    // Regn signalerne FØR AI'en kaldes - den skal forklare resultatet, ikke danne det.
    let signaler = null;
    try {
        signaler = beregnSignaler(dagensOpsummering, drivere);
    } catch (err) {
        console.warn("Kunne ikke beregne signaler (springer over):", err.message);
    }

    await hentAiAnalyse(produkter, dagensOpsummering, drivere, signaler);
}

hentPriser().catch(error => {
    console.error("Der opstod en fejl:");
    console.error(error);
    process.exitCode = 1;
});
