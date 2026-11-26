# WebTopo – bezpapierové mapovanie jaskýň v prehliadači

Webová aplikácia (PWA) v štýle PocketTopo pre Android. Priamo cez Bluetooth zbiera merania z prístroja, ťah rozpozná z 3 zhodných meraní, kreslí sa v nej pôdorys a rozvinutý rez a exportuje do Therionu. Po prvom otvorení funguje offline.

## Čo treba

- **Android + Chrome 138 alebo novší.** Klasický Bluetooth (DistoX2) ide cez Web Serial a BLE prístroje cez Web Bluetooth.
- **iPhone nefunguje,** lebo Safari nemá ani Web Serial, ani Web Bluetooth.
- Stránka musí bežať na **HTTPS** (napr. GitHub Pages), inak prehliadač Bluetooth nepovolí.

## Nasadenie na GitHub Pages

1. Vytvor repozitár (napr. `webtopo`) a nahraj doň obsah tohto priečinka: `index.html`, `sw.js`, `manifest.webmanifest`, `icon-*.png`. Priečinok `vyvoj/` je voliteľný.
2. Otvor Settings → Pages → *Deploy from a branch* → `main` / root.
3. Na telefóne otvor `https://<meno>.github.io/webtopo/` v Chrome a cez ⋮ → **Pridať na plochu** ju nainštaluj ako appku.
4. Pri novej verzii stačí nahrať nový `index.html` a `sw.js`. Appka sa aktualizuje pri najbližšom otvorení so signálom.

## Prístroje

| Prístroj | Spojenie | Poznámka |
|---|---|---|
| DistoX2 / DistoX | klasický BT (SPP) → Web Serial | najprv spárovať v Nastaveniach Androidu (PIN 0000) |
| DistoX BLE | BLE (Nordic UART) | nepárovať v systéme |
| SAP6 / DiscoX | BLE (caveble) | |
| SAP5 | BLE sériový most | |
| BRIC4 / BRIC5 | BLE | duplicitné merania sa filtrujú podľa indexu |
| Iný BLE | BLE | protokol sa zistí podľa služieb |
| Simulátor | – | na vyskúšanie bez prístroja |

Prístroj sa vyberá zo zoznamu len prvýkrát (alebo cez „Iný prístroj“). Potom sa appka pripája sama bez okna výberu, po výpadku aj po spustení; „Odpojiť“ automatické pripájanie vypne. Každý paket sa potvrdí (ACK). Ak spojenie vypadne, appka sa skúša znovu pripojiť každé 4 s a prístroj medzitým drží neodoslané merania v pamäti. Prístroj → **Denník komunikácie** ukazuje surové pakety v hex, čo pomôže pri ladení so skutočným prístrojom.

**Nebolo odskúšané so skutočným prístrojom.** Protokoly sú prevzaté zo zdrojových kódov SexyTopo a TopoDroid a overené na ich testovacích paketoch. Komunikácia bola testovaná s falošným DistoX2 a DistoX BLE v Chrome. Prvá vec na skúšku je DistoX2 cez Web Serial na Androide. Ak sa v zozname neobjaví, zaškrtni „Ukázať všetky sériové zariadenia“.

## Práca v jaskyni

- **Od → Do** (pásik hore): aktuálna stanica a názov ďalšej, ťuknutím ich zmeníš. Nový prieskum začína bodom **1**, ďalej 2, 3… Odbočka zo staršej stanice dostane ďalšie voľné číslo; pri názvoch so sériou (1.3) začne novú sériu (2.1).
- Každé meranie je zámer z aktuálnej stanice. **3 zhodné merania** (±5 cm, ±1,7°) = ťah a aktuálnou stanicou sa stane Do. Štvrté zhodné meranie ťah len spresní. Tolerancie a počet meraní (2/3/vypnuté) sú v Nastaveniach.
- **Tabuľka:**
  - Ťuknutie na riadok ho označí, aj v náčrte.
  - Šípka ▸ pred riadkom otvorí menu bodu: otočiť ťah, rozvinúť ‹ ›, pokračovať, premenovať, upraviť, rozdeliť, vymazať.
  - Dvojklik alebo dlhé podržanie na hodnote ju priamo upraví; na ‹ › prepne smer v reze.
  - **Posledný riadok** je nové meranie ručne z aktuálnej stanice: Do (prázdne = zámer), dĺžka, azimut, sklon a potom Enter alebo +.
  - ↶ pri pásiku Od → Do vráti posledný krok v dátach (meranie, úpravu, mazanie, zmenu staníc).
- **Náčrt** je na celú obrazovku (horné lišty sú len v tabuľke): predvolene posun, dva prsty zväčšujú, + a − priblížia a oddialia. Pero (prvé ťuknutie zapne pero, druhé otvorí farby) kreslí. Guma maže celé čiary, ↶ vráti krok.
- **⌖** dá aktívny (posledne pridaný) bod do stredu a priblíži tak, aby bol na obrazovke celý jeho polygón. Mriežka je vždy 1 m; pri veľkom oddialení slabne a pod 3 px na meter sa nekreslí.
- Ťuknutý bod v náčrte aj kliknutý riadok tabuľky ostanú jemne zvýraznené. Vybraný riadok je zvýraznený aj v náčrte.
- **Ťuknutie na bod v náčrte** otvorí jeho menu: hore „Bod X“ a pod ním „z bodu Y“. Tlačidlá sú v dvoch riadkoch: otočiť ťah Y – X, pokračovať z X, premenovať a rozvinúť ‹ / › len ťah do bodu alebo všetko odtiaľ ďalej (smerom od počiatku). Čiary sú ukotvené k najbližšej stanici, takže sa pri oprave dát posunú s ňou.
- Záložky Dáta / Pôdorys / Rez sú ikony. **Na šírku** ostanú horné lišty hore, nástroje náčrtu a záložky idú do zvislých stĺpcov na strane, kde je spodok telefónu.
- V menu je voľba **Nezhasínať obrazovku**.
- **Ukladanie:** každá zmena (meranie, úprava, čiara náčrtu) sa hneď zapíše do pamäte prehliadača v telefóne (IndexedDB), pri odchode z appky ešte raz. Pád appky, vybitie či vypnutie telefónu dáta nezmažú; po otvorení sa načíta posledný prieskum. Vymazanie údajov Chromu, odinštalovanie appky alebo strata telefónu áno – preto pravidelne Export (záloha .json sa dá načítať cez Import).

## Export a import

- **Balík pre Therion (.zip):**
  - `.th`: centreline, `data normal from to length compass clino`, zámery ako `-`, `extend left/right`, dátum, tím, deklinácia a fix.
  - `_p.th2` / `_e.th2`: scrap s bodmi staníc, mierkou v hlavičke (`-scale [0 0 787.402 0 0 0 10 0 m]`) a vloženým `.xvi` podkladom (náčrt, ťahy, zámery, mriežka 1 m) pre xtherion a PreTherion.
  - `.xvi` je v 78,74 jednotkách na meter, rovnako ako PocketTopo podklad. PreTherion z neho aj zo scrapov načíta mierku 0,0127 m na jednotku.
  - `_pockettopo.txt`: rovnaký formát ako „Export Therion“ z PocketTopo, takže xtherion → Import PocketTopo funguje ako doteraz.
  - `.webtopo.json`: úplná záloha.
- **Import:** PocketTopo `.txt` (Therion export, aj s náčrtom) a záloha `.json`. Binárny `.top` zatiaľ nie.

Overenie: z importovaného vzorového súboru PocketTopo (Therion test `pocket-topo/Demo.txt`) sa vyexportoval balík a Therion 6 ho skompiloval. Skreslenie scrapov bolo 0,00 % priemer a 0,01 % maximum v pôdoryse aj v reze, takže polohy staníc v .th2 sedia s výpočtom Therionu. Stanice sedia s polohami z PocketTopo do 5 cm (rozdiel spôsobuje zaokrúhlenie dát v .txt).

## Vývoj (`vyvoj/`)

- `src/core.js`: protokoly, merania, geometria, exporty a importy (bez UI, testovateľné v Node).
- `src/app.js`, `src/index.html`: rozhranie.
- `tools/build.py`: zostaví jeden `index.html` s vloženým kódom a `sw.js` s novou verziou cache.
- `test/core.test.js` (`node test/core.test.js`): 23 testov jadra. Pakety DistoX, SAP6 a BRIC, ťahy a číslovanie staníc, rozvinutie, porovnanie s PocketTopo a Therionom.
- `test/ui_test.py`: 58 testov rozhrania v Chrome s falošným DistoX2 a DistoX BLE (Playwright). Spúšťa sa `python3 test/ui_test.py <dist> <out>`. Cesta k vzorovému `Demo.txt` je v skripte.
