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

// Finder produktlinks på en kategoriside ved at kigge efter "...Np.html"-links,
// robust over for præcise klassenavne på siden.
async function laesProduktLinks(page) {
    return page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="p.html"]'));
        const set = new Set();
        for (const link of links) {
            const href = link.getAttribute("href");
            if (href) set.add(href);
        }
        return Array.from(set);
    });
}

async function findProduktUrls(browser) {
    let url = START_URL;
    const besoegteSider = new Set();
    const produktUrls = new Set();

    for (let side = 1; side <= MAX_KATEGORISIDER && url; side++) {
        console.log("Finder produkter på side " + side + ": " + url);
        besoegteSider.add(url);
        const page = await browser.newPage({ locale: "da-DK" });
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

        const links = await laesProduktLinks(page);
        for (const href of links) produktUrls.add(new URL(href, url).toString());

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
    return Array.from(produktUrls);
}

async function laesProdukt(browser, url) {
    const page = await browser.newPage({ locale: "da-DK" });
    try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

        const titelLoc = page.locator("h1").first();
        const titel = (await titelLoc.count()) ? ((await titelLoc.textContent().catch(() => "")) || "").trim() : "";
        if (!titel) return null;

        const bodyTekst = (await page.locator("body").textContent().catch(() => "")) || "";

        const prisMatch = bodyTekst.match(/(\d[\d.]*,\d{2})\s*DKK\s*pr\.?\s*kg/i);
        const prisPrKg = prisMatch ? tal(prisMatch[1].replace(/\./g, "")) : null;

        let paaLager = null, antalPaaLager = null;
        const lagerMatch = bodyTekst.match(/(\d+)\s*\n?\s*På lager/i);
        if (lagerMatch) {
            paaLager = true;
            antalPaaLager = Number(lagerMatch[1]);
        } else if (/Ikke\s*på\s*lager/i.test(bodyTekst) || /LEVERINGSTID\s*UKENDT/i.test(bodyTekst)) {
            paaLager = false;
        }

        const specsLoc = page.locator("#specs");
        const specsTekst = (await specsLoc.count()) ? ((await specsLoc.first().textContent().catch(() => "")) || "") : "";
        const specs = udtraekSpecs(specsTekst);

        return {
            produkt: titel,
            maerke: maerkeFraNavn(titel),
            type: typeFraNavn(titel),
            mm: mmFraNavn(titel),
            prisPrKg,
            paaLager,
            antalPaaLager,
            ...specs,
            kilde: url
        };
    } finally {
        await page.close();
    }
}

async function hentPriser() {
    console.log("Starter browseren...");
    const browser = await chromium.launch({ headless: true });

    const produktUrls = await findProduktUrls(browser);
    console.log("Fandt " + produktUrls.length + " produkter. Henter detaljer for hvert...");

    const produkter = [];
    for (const url of produktUrls) {
        try {
            const p = await laesProdukt(browser, url);
            if (p) produkter.push(p);
        } catch (err) {
            console.warn("Kunne ikke læse " + url + ": " + err.message);
        }
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
    console.log("\nFærdig. Antal produkter:", produkter.length, "| Tid:", resultat.hentetDanskTid);
}

hentPriser().catch(error => {
    console.error("Der opstod en fejl:");
    console.error(error);
    process.exitCode = 1;
});
