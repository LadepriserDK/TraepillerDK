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
    "Vildbjerg", "Egetræpiller", "Olczyk", "HP"
];
function maerkeFraNavn(navn) {
    for (const m of KENDTE_MAERKER) {
        if (navn.toLowerCase().includes(m.toLowerCase())) return m;
    }
    return navn.split(" ")[0];
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

// Besøger hver produktside udelukkende for at læse specifikationer (aske/fugt/brændværdi) -
// de findes ikke på oversigten. Scanner hele sidens tekst frem for at stole på et bestemt
// element-id, som kan mangle eller kræve et klik for at blive synligt.
async function laesSpecsForProdukt(browser, url) {
    const page = await browser.newPage({ locale: "da-DK" });
    try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        const bodyTekst = (await page.locator("body").textContent().catch(() => "")) || "";
        return udtraekSpecs(bodyTekst);
    } catch (err) {
        console.warn("Kunne ikke læse specs fra " + url + ": " + err.message);
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
const SEED_TYSK_MARKEDSINDEKS = [
    { dato: "2025-01", eurPrTon: 306.35, dkkPrKg: 2.29 },
    { dato: "2025-03", eurPrTon: 380.20, dkkPrKg: 2.84 },
    { dato: "2025-06", eurPrTon: 302.45, dkkPrKg: 2.26 },
    { dato: "2025-07", eurPrTon: 302.69, dkkPrKg: 2.26 },
    { dato: "2025-10", eurPrTon: 366.25, dkkPrKg: 2.73 },
    { dato: "2025-11", eurPrTon: 392.62, dkkPrKg: 2.93 },
    { dato: "2026-01", eurPrTon: 405.33, dkkPrKg: 3.02 },
    { dato: "2026-04", eurPrTon: 405.11, dkkPrKg: 3.02 },
    { dato: "2026-06", eurPrTon: 376.77, dkkPrKg: 2.81 },
    { dato: "2026-07", eurPrTon: 388.09, dkkPrKg: 2.90 }
];
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

        const prisMatch = tekst.match(/durchschnittlich\s+([\d.,]+)\s*Euro/i);
        if (!prisMatch) throw new Error("Kunne ikke læse pris ud af DEPI-artiklen: " + url);
        const eurPrTon = Number(prisMatch[1].replace(/\./g, "").replace(",", "."));

        const maanedMatch = tekst.match(/\b(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+(20\d{2})\b/i);
        if (!maanedMatch) throw new Error("Kunne ikke læse måned/år ud af DEPI-artiklen: " + url);
        const maanedNr = TYSKE_MAANEDSNAVNE[maanedMatch[1].toLowerCase()];
        const dato = maanedMatch[2] + "-" + String(maanedNr).padStart(2, "0");

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

        for (const seedPunkt of SEED_TYSK_MARKEDSINDEKS) {
            if (!data.maaneder.some(m => m.dato === seedPunkt.dato)) {
                data.maaneder.push({ ...seedPunkt, kilde: "https://www.depi.de/pelletpreis-wirtschaftlichkeit/" });
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

// Beder en gratis AI (Groq) om en kort dansk forklaring på markedet ud fra dagens
// tal. Nøglen læses UDELUKKENDE fra miljøvariablen GROQ_API_KEY (sat som en GitHub
// Secret) - den står aldrig i denne fil. Fejler dette, springes det bare over.
async function hentAiAnalyse(produkter, dagensOpsummering) {
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

        const kontekst = [
            `Antal varer på lager hos Pillemadsen lige nu: ${dagensOpsummering.antalPaaLager} af ${dagensOpsummering.antalTotal}.`,
            `Gennemsnitspris 6 mm på lager: ${dagensOpsummering.gnsPris6mmPaaLager ?? "ukendt"} kr/kg.`,
            `Gennemsnitspris 8 mm på lager: ${dagensOpsummering.gnsPris8mmPaaLager ?? "ukendt"} kr/kg.`,
            udsolgteMaerker.length ? `Helt udsolgte mærker lige nu: ${udsolgteMaerker.join(", ")}.` : "Ingen mærker er helt udsolgte lige nu.",
            depiSaetning
        ].filter(Boolean).join(" ");

        const systemPrompt =
            "Du er en kort, nøgtern markedsanalytiker for det dansk-tyske træpillemarked. Du har adgang til at søge " +
            "på nettet efter aktuelle nyheder og forhold, der påvirker markedet. Du svarer altid på dansk, i " +
            "almindelig løbende tekst - ingen markdown, ingen overskrifter, ingen punktopstilling, ingen emojis. " +
            "Brug de tal, du får oplyst i beskeden, sammen med det du finder ved søgning - men opfind aldrig tal, " +
            "citater eller kilder, du ikke faktisk har fundet. Tonen er rolig og faktuel - hverken sælgende eller " +
            "alarmerende - og du giver ikke direkte købsråd eller finansiel rådgivning.";

        const userPrompt =
            "Søg efter aktuelle nyheder og markedsforhold, der kan forklare situationen på det danske og tyske " +
            "træpillemarked lige nu - fx forsyningsproblemer, det polske statstilskud til pilleovne (indført 2025, " +
            "som har reduceret polsk eksport af træpiller), vejrudsigt/fyringssæson, energipriser i øvrigt, eller " +
            "andre relevante begivenheder fra den seneste tid.\n\n" +
            "KOMBINÉR det du finder med disse tal:\n" + kontekst + "\n\n" +
            "OPGAVE: Skriv 4-6 sætninger på dansk med en samlet markedsanalyse - både hvad tallene viser, og hvad " +
            "du har fundet af forklaringer i nyhederne. Nævn kort hvor en central oplysning kommer fra (fx 'ifølge " +
            "nyheder fra...'), hvis du bruger noget fra søgningen. Du må gerne afslutte med en kort, forsigtig " +
            "antydning af retningen (stigende, faldende eller stabil) - men undgå bombastiske konklusioner.";

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey,
                "Groq-Model-Version": "latest"
            },
            body: JSON.stringify({
                model: "groq/compound",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.4,
                max_tokens: 500
            })
        });

        if (!res.ok) throw new Error("Groq API svarede med status " + res.status);
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

// Den offentlige VAPID-nøgle er IKKE hemmelig - den skal netop deles med browseren.
// Kun den private nøgle er hemmelig og hentes fra en GitHub Secret.
const VAPID_PUBLIC_KEY = "BNsOC00BEuHqjo7vy39nm2qfjET9cOuXljmXp9J-Xi3yLPJPfVKFwzyAm0dv7gd32Mw1nNGfknL9-izYPIumUxk";

// Sender en rigtig push-besked til hver gemt abonnent, hvis billigste pris på
// lager er faldet til eller under deres grænse. Kører kun hvis den private
// VAPID-nøgle er sat som GitHub Secret - ellers springes det stille over.
async function sendPushAlarmer(produkter) {
    const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY;
    if (!privateKey) {
        console.warn("Ingen PUSH_VAPID_PRIVATE_KEY sat - springer push-alarmer over.");
        return;
    }

    let abonnenter = [];
    try {
        abonnenter = JSON.parse(fs.readFileSync("push-abonnementer.json", "utf8"));
        if (!Array.isArray(abonnenter)) abonnenter = [];
    } catch (e) {
        console.warn("Kunne ikke læse push-abonnementer.json - springer push-alarmer over.");
        return;
    }
    if (!abonnenter.length) {
        console.log("Ingen push-abonnenter endnu.");
        return;
    }

    webpush.setVapidDetails("mailto:traepillerdk@example.com", VAPID_PUBLIC_KEY, privateKey);

    const medPris = produkter.filter(p => p.paaLager === true && p.prisPrKg !== null);
    const billigste = medPris.slice().sort((a, b) => a.prisPrKg - b.prisPrKg)[0];
    if (!billigste) {
        console.log("Ingen varer på lager med pris - springer push-alarmer over.");
        return;
    }

    for (const ab of abonnenter) {
        if (!ab.subscription || typeof ab.graense !== "number") continue;
        if (billigste.prisPrKg > ab.graense) continue;
        const payload = JSON.stringify({
            titel: "Prisalarm: " + billigste.maerke,
            tekst: billigste.maerke + " er nede på " + billigste.prisPrKg.toFixed(2) + " kr/kg (din grænse: " + ab.graense.toFixed(2) + " kr/kg)",
            url: "./index.html"
        });
        try {
            await webpush.sendNotification(ab.subscription, payload);
            console.log("Push sendt til abonnent.");
        } catch (err) {
            console.warn("Kunne ikke sende push til en abonnent (springer over):", err.message);
        }
    }
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
        const paaLager = /ikke\s*på\s*lager/i.test(tekst) ? false : (/på\s*lager/i.test(tekst) ? true : null);

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
            paaLager,
            antalPaaLager: null,
            ...specs,
            kilde: url
        });
    }

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

    console.log("\nFærdig. Antal produkter:", produkter.length, "| Tid:", resultat.hentetDanskTid);
    console.log("Historik har nu", historik.length, "dag(e) med data.");

    await sendPushAlarmer(produkter);

    const browser2 = await chromium.launch({ headless: true });
    await hentTyskMarkedsindeks(browser2);
    await browser2.close();

    await hentAiAnalyse(produkter, dagensOpsummering);
}

hentPriser().catch(error => {
    console.error("Der opstod en fejl:");
    console.error(error);
    process.exitCode = 1;
});
