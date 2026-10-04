# WORKPLAN — rencana kerja agen (turunan, BUKAN authoritative)

**Status:** dokumen turunan. Dibuat 2026-10-04 oleh agen (Hermes), direvisi setelah audit menyeluruh.
**Aturan penting:** dokumen ini **tidak menambah otoritas baru**. Kalau isinya bertentangan dengan
`docs/tasks/README.md`, `docs/specs/*`, `docs/adr/*`, atau `docs/CODING_AGENT.md`, yang authoritative menang.
Fungsi file ini tiga: (1) mencatat keputusan lingkungan pemilik, (2) memetakan di mana fakta penting hidup
(agar agen berikutnya tidak mengulang audit), (3) menjelaskan urutan kerja + gate review.
Status task tetap dilacak di `docs/tasks/README.md`.

---

## 1. Kondisi repo saat ini

- **Phase 0 (M0 Scaffold) SELESAI** — `P0-01`…`P0-04` semua `done`.
- **Phase 1 (Protocol) SELESAI** — `P1-01`…`P1-04` semua `done`. `packages/protocol` utuh: id + `BosError`, seluruh
  tipe data model, 22 zod schema yang cocok dua arah dengan tipenya, 36 method RPC, masking, EventBus, paths, target syntax.
- **Belum ada logika produk** — belum ada browser, DOM, atau router. Itu mulai di Phase 2.
- Repo publik di **https://github.com/glatinone/browser-os** (branch `main`). CI hijau di dua jalur: push ke `main`
  dan pull request.
- **GATE G0 lulus** (2026-10-04) dari clone bersih, dan terulang di CI setiap push. Gate berikutnya: **G1** setelah `P3-07`.
- Task berikutnya menurut rencana: `P2-01` (lihat `docs/tasks/README.md`).

## 2. Keputusan lingkungan (diambil pemilik, 2026-10-04)

| # | Hal | Keputusan | Konsekuensi dokumen |
|---|---|---|---|
| D1 | Package manager | **pnpm 12.8.1** (yang sudah terinstall di `~/.npm-global`), bukan `pnpm@9.15.0` | Koreksi pin di kartu `P0-01` + `packageManager` + ADR-016 saat P0-01 dikerjakan |
| D2 | Versi Node | **Node 26** (terinstall: v26.7.0, ABI 147) | Update `.nvmrc` (`22` → `26`) dan `engines.node` saat P0-01 dikerjakan |
| D3 | Git & CI | **`git init` lokal + commit.** `P0-03` (CI) ditandai `review` sampai ada remote GitHub | P0-03 dikerjakan, tapi acceptance "workflow green on a PR" belum bisa dibuktikan tanpa remote |
| D4 | Penyimpanan | **Tetap `better-sqlite3`** sesuai ADR-004. `node:sqlite` tidak dipakai di MVP | Tidak ada perubahan; ADR-004 follow-up "REPLACE LATER" tetap berlaku |
| D5 | Lisensi | Apache-2.0 (ADR-018), sudah RESOLVED. **Aksi pemilik:** konfirmasi izin employer sebelum push publik pertama | Sudah tercatat di `docs/tasks/CONFLICTS.md` |
| D6 | Silsilah kode | **Bukan fork/clone apa pun.** Tidak ada kode pihak ketiga yang di-vendor; port hanya lewat izin eksplisit kartu task | Lihat §4 (silsilah & disiplin lisensi) |

`corepack` **tidak dipakai**: Node 25+ tidak lagi membundel corepack, dan shim lama di mesin ini menunjuk file yang tidak ada.
`packageManager` di `package.json` tetap ditulis sebagai dokumentasi, tapi pemasangan pnpm dilakukan manual (`npm i -g pnpm@12.8.1`),
dan `~/.npm-global` harus ada di `PATH`.

## 3. Fakta lingkungan terverifikasi (probe 2026-10-04 — jangan diulang)

Diuji nyata di mesin ini, bukan asumsi:

| Yang diuji | Hasil |
|---|---|
| `node` | v26.7.0, ABI (`process.versions.modules`) **147**. Node kedua v24.18.0 ada di `C:\Program Files\nodejs` |
| `corepack` | Rusak / tidak ada — jangan andalkan |
| `pnpm` | 12.8.1 terinstall di `~/.npm-global` (**belum di PATH**): `export PATH="$HOME/.npm-global:$PATH"` |
| `better-sqlite3@13.0.3` | Install + `new Database(':memory:')` berhasil di Node 26 **tanpa MSVC/build tools** (prebuilt tersedia) |
| `playwright-core` + Chrome asli | `launchPersistentContext(dir, { channel:'chrome', pipe:true, headless:true })` → **3,1 s**, CDP session OK, `Accessibility.getFullAXTree` + `DOMSnapshot.captureSnapshot` jalan, close bersih. Chrome 154.0.8037.58 |
| Chrome / Edge | Dua-duanya terinstall di mesin ini (untuk sesi nyata, bukan untuk CI) |
| `node:sqlite` | Jalan di Node 26 tanpa flag (dicatat sebagai opsi ADR di masa depan, **tidak dipakai** — lihat D4) |
| Lain-lain | git 2.54.0 · gh 2.100.0 · python 3.14.7 · sisa disk 149 GB |

Kesimpulan: tidak ada blocker teknis di lingkungan. Tiga risiko terbesar rencana (native build, corepack, launch Chrome di Windows) sudah gugur.

---

## 4. Silsilah & disiplin lisensi

**Repo ini bukan fork dan bukan clone.** Tidak ada `.git`, tidak ada remote, tidak ada `.gitmodules`, tidak ada kode
pihak ketiga yang di-vendor. Satu-satunya file non-markdown di repo: 4 file brainstorming `.txt` di `docs/history/`,
`LICENSE`, dan `NOTICE`. `OSS_STRATEGY.md` §2 (baris terakhir) menyatakan: *"Nothing in Browser-OS is classified
FORK or VENDOR."* Keputusan itu disengaja — `docs/history/README.md` mencatat *"No forks on day one."*

**Asal-usul:** `docs/history/01-master-spec-browserskill-ultra.txt` — master spec pertama proyek ini dinamai kerja
**"BrowserSkill Ultra"**, tujuannya menggabungkan sesi terautentikasi milik **BrowserSkill** (Tencent, MIT) dengan
layer AI/aksi yang jauh lebih optimal. Jadi inspirasi utamanya = **BrowserSkill**; proyek lain menyusul sebagai referensi.

| Sumber | Lisensi | Yang diambil | Boleh salin kode? |
|---|---|---|---|
| **BrowserSkill** (Tencent) | MIT, pin `@3f10983` | DOMSnapshot ⨝ AX by `(frameId, backendNodeId)`, isolasi per-frame, `effect_state`, modal folding, name-resolution priority | **Ya, terbatas** — hanya lewat izin kartu task (`port: allowed`) |
| **Stagehand** | MIT, pin `@3.7.3` | cache by instruction + URL + nama param, self-heal lalu rewrite | Referensi saja |
| **Browser Use** | MIT (Python) | paint-order occlusion, clickable heuristics, 5-level re-identification ladder | Referensi saja |
| **Steel** | Apache-2.0 | bentuk session lifecycle API | Referensi saja |
| **workflow-use** | **AGPL-3.0** | konsep trajectory (semantic target + ordered selector) | **TIDAK — konsep saja, tanpa kode sama sekali** |
| **Lightpanda** | **AGPL-3.0** | — (provider masa depan, hanya bicara lewat CDP) | **TIDAK** — jangan pernah di-link |
| Skyvern, Notte | AGPL / SSPL | — | **TIDAK** |

**Dua titik risiko nyata untuk agen:**

1. **`P4-02` (capture) dan `P4-03` (join) adalah lokasi persis izin SELECTIVE PORT.** `OSS_STRATEGY.md` §2 memberi izin
   port dari BrowserSkill `tools/vom/*` (MIT) untuk area ini. Bila port dilakukan, prosedur §5 wajib diikuti: kartu task
   menyebut `port: allowed from <repo>@<commit> <path>`, lisensi diverifikasi di commit itu, header komentar ditambahkan
   (`// Portions adapted from … See THIRD_PARTY_NOTICES.md.`), entri masuk `THIRD_PARTY_NOTICES.md`, dan disebut di
   laporan (DECISIONS). **Default-nya tetap: implement dari spec, jangan port.**
2. **`P7-05`/`P7-06` (recorder/replayer) duduk paling dekat dengan workflow-use yang AGPL.** Konsepnya boleh dipelajari,
   kodenya tidak boleh disalin — bahkan potongan kecil. Tidak ada test yang bisa menangkap pelanggaran ini, jadi ini
   murni disiplin di titik kerja.

Aturan turunan (mengikat): `CODING_AGENT.md` rule 4 · `OSS_STRATEGY.md` §0, §5 · `THIRD_PARTY_NOTICES.md`.

---

## 5. Peta informasi untuk agen (hasil audit — di mana fakta penting hidup)

**Jangan cari ulang.** Baca sesuai kolom kanan.

| Butuh | Baca |
|---|---|
| Cara memilih + menyelesaikan satu task, format laporan | `CODING_AGENT.md` §4, §9, §10 |
| Urutan otoritas dokumen saat bentrok | `CODING_AGENT.md` §3, `docs/README.md` |
| Kontrak lintas-task (masking, RouterDeps, driver, budget, challenge, task, fake model, launch) | `specs/integration.md` — **menang atas spec lain** |
| Lokasi data & isi `BOS_HOME` | `specs/memory.md` §2 |
| Config resmi (bukan `.env`) | `specs/protocol.md` §6 — `<BOS_HOME>/config.json`; hanya **nama** env var API key yang disimpan |
| Method RPC, sintaks target, perintah CLI, exit code | `specs/protocol.md` §4, §5 |
| Tier ladder, konstanta router, `resolveLocator`/healing, prompt LLM | `specs/action-router.md` §2–§6 |
| Batas package yang ditegakkan script | `CODING_AGENT.md` §7 + task `P0-02` |
| Angka target resmi | `PERFORMANCE.md` (L1–L18, R1–R5, E1–E8, H1–H4). Angka di ROADMAP/kartu = informal, kalah |
| Gate milestone G1–G6 | akhir `docs/tasks/README.md` |
| Supervisi task (authoritative) | kolom **Supervision** di `docs/tasks/README.md` |
| Aturan + daftar target situs nyata | `COMPATIBILITY.md` §2 dan **ADR-019** |
| Coverage minimum | `TESTING.md` §9 |
| Kebijakan golden & fixture | `TESTING.md` §5 |

**Invarian yang diuji, bukan sekadar dikomentari** (melanggar = task gagal walau test hijau):

- 0 panggilan LLM di tier cache/deterministic (`FakeModelProvider.calls === 0`).
- `effect: 'unknown'` **tidak pernah** di-retry dan tidak pernah fallback ke Playwright.
- 0 screenshot di luar tier vision; 0 vision call di MVP.
- Tidak ada secret (canary) di SQLite, log, trace, event, atau prompt.
- Tidak ada file `DevToolsActivePort` dan tidak ada `--remote-debugging-port` di launch args.
- Jangan `Runtime.enable`. JS sisi halaman hanya jalan di isolated world `bos`.
- Tidak ada fixed sleep — semua tunggu lewat `settle()` atau probe loop.
- Urutan verifikasi: **`pnpm build` dulu**, baru `typecheck`/`test` (package export `./dist`, sumber lewat kondisi `source`).

**Task berlabel `expert`** (butuh review manusia/model kuat sebelum `done`):
`P3-02`, `P4-03`, `P4-08`, `P7-02`, `P7-03`, `P8-04`, `P9-01`, `P11-02`, `P11-04`, `P12-03`.

**Situs nyata (Fase G):** manual & opt-in, headful, ≥2 s antar aksi, ≤30 aksi/situs/hari, `--i-understand-tos`,
satu profil per situs, akun uji sendiri. **LinkedIn, Instagram, Facebook, X tidak diuji** (ToS). Tenant employer hanya
dengan izin tertulis IT/security.

## 6. Hazard khusus Windows (mesin ini)

| Area | Bahaya | Aturan |
|---|---|---|
| Path di script | Pemisah path salah | Selalu `node:path`; jangan rangkai string path |
| Lock profil | Deteksi beda per OS | POSIX: symlink `SingletonLock` (`hostname-pid`). Windows: open `lockfile` untuk write → `EBUSY`/`EPERM` = terkunci |
| Token ACL (`P8-04`) | `chmod` tidak ada di Windows | Windows: `icacls /inheritance:r /grant:r "%USERNAME%:F"`, verifikasi dengan parse output `icacls` |
| Crash test `P2-07` | Kill pid tidak portabel | Kirim `Browser.close` lewat CDP; kalau gagal, cabang Windows **di-skip** dan didokumentasikan |
| Channel browser | `chrome`/`msedge` tidak terinstall → jangan diam-diam jatuh ke Chromium bundled | `BROWSER_NOT_FOUND` (integration §13) |
| Test lintas-OS | `skipif(sys.platform …)` tidak dijalankan lane mana pun | Pakai marker `platforms(...)`, satu marker per test |

---

## 7. Fase kerja (diselaraskan dengan penomoran phase repo)

Supervisi mengikuti kolom authoritative di `docs/tasks/README.md`. Gate **[aku]** bisa kuverifikasi sendiri,
**[kamu]** butuh penilaianmu.

**FASE A — Phase 0 · M0 Scaffold.** `P0-01`, `P0-02`, `P0-04` (P0-03 paralel), plus langkah toolchain
(pnpm ke `PATH`; keputusan D1–D6 + ringkasan probe ditulis ke `docs/tasks/CONFLICTS.md`).

| Task | Isi | Supervision |
|---|---|---|
| `P0-01` | Monorepo pnpm/TS: 9 package kosong (`protocol, browser, dom, ai, memory, runtime, daemon, sdk, cli`), `tsc -b` project references, biome, vitest 3 project (`unit`/`browser`/`e2e`), 9 smoke test, `packages/cli` bin `bos` | cheap |
| `P0-02` | `scripts/check-boundaries.mjs` — penjaga batas dependency per package; 5 test case | cheap |
| `P0-04` | `fixtures/server.ts` + **13 halaman fixture** + `truth.json` (≥8 intent/halaman) + `tests/helpers` (`withFixtureServer`, `withTempBosHome`, `fakeClock`) | cheap |
| `P0-03` | `.github/workflows/ci.yml` (linux, windows, nightly-bench) | cheap → tandai `review` (tanpa remote, acceptance tidak terbukti) |

`P0-04` adalah yang paling menentukan: seluruh test browser, golden test, dan benchmark bergantung ke halaman-halaman ini.
Sekaligus menerapkan D1–D3 (pin pnpm, `.nvmrc`/`engines` = 26, `git init`).

**GATE G0 [aku]:** `pnpm build && pnpm -r typecheck && pnpm lint && pnpm test` hijau di Windows, dari clone bersih.
Keluaran: repo yang bisa dibangun + dites; nol kode produk.

**FASE B — Phase 1 + 5 + 6 (paralel, package berbeda).** `P1-01`…`P1-04`; `P5-01`…`P5-04`; `P6-01`…`P6-04`
`protocol` dulu (semua package bergantung ke sini): ids/errors, tipe `specs/data-models.md`, zod schema + tabel method RPC,
`mask.ts`/EventBus/paths/target syntax. `SENSITIVE_NAME_RE` (integration §2) adalah **satu-satunya** sumber regex
sensitivitas — kalau ini salah, secret bisa lolos ke log/SQLite/prompt. Coverage ≥ 85%.

**Jalur paralel (package berbeda, aman dijalankan terpisah):**
- `P5-01` … `P5-04` (AI): `FakeModelProvider` dulu — **tanpa API key, tanpa vendor SDK** (ADR-012).
- `P6-01` … `P6-04` (memory): `better-sqlite3`, test pakai SQLite `:memory:`.

Keluaran: kosakata bersama yang dipakai semua package.

**FASE C — Phase 2 + 3 · M1 "Tangan".** `P2-01`…`P2-07`, lalu `P3-01`…`P3-07`
Profil milik Browser-OS sendiri (tidak pernah profil Chrome default user), `LaunchProvider` (pipe, tanpa port debug),
CDP transport + isolated world `bos`, `SessionManager`; lalu `PageDriver`: navigate, click/hover dengan hit-test,
fill/press/select/scroll, fallback Playwright, `settle`, upload/download.
`P3-02` (hit-test + semantik `effect`) levelnya **expert** — kukerjakan, kutandai `review`.

**GATE G1 [aku + kamu]:** `P3-07` e2e — launch profil → navigate fixture `basic` → fill/click via CDP → **cookie bertahan setelah relaunch**.
Bukti pertama produknya nyata. Fokus review: `effect` benar di semua jalur, dan tidak ada debug port terekspos (SECURITY §2).

**FASE D — Phase 4 · M2 "Mata".** `P4-01`…`P4-12`
Capture (`DOMSnapshot` + AX tree) → join jadi `NodeTable` → filter interactive/visible (+ modal scoping) →
`SemanticElement` ~1k token → `ElementLocator` fingerprint → probe ≤ 4 CDP round-trip → challenge detection.
Expert: `P4-03` (join), `P4-08` (locator build/match); `P4-09` (probe) levelnya review.

**`P4-02`/`P4-03` = lokasi izin SELECTIVE PORT BrowserSkill — baca §4 sebelum menulis kode di sini.**

**GATE G2 [kamu]:** golden test `P4-05` — *"apakah hasil observasinya benar?"*
Golden di sini mendefinisikan perilaku semua fase setelahnya. Keputusan ini lebih murah kamu lihat sendiri daripada kutebak.
Target: lexical precision ≥ 99% pada `truth.json`, oracle agreement ≥ 95% vs Playwright `ariaSnapshot`, mutation suite ≥ 95%.

**FASE E — Phase 7 · M3 (tesis).** `P7-01`…`P7-08`
Tier ladder (cache → deterministic → LLM → human), budget, recorder, replayer + healing, `createRuntime()`, `TaskManager`.
`P7-02` dan `P7-03` levelnya **expert**.

**`P7-05`/`P7-06` = titik terdekat dengan workflow-use yang AGPL — konsep saja, tanpa kode (lihat §4).**

**GATE G3 [kamu]:** `P7-08` — replay task fixture SPA: **0 LLM call**, semua step `tier=cache`,
≥3× lebih cepat dari run rekam (FakeModel latency 800 ms), dan tetap sukses setelah fixture dimutasi
(`?variant=mutated`). **Di sini keputusanmu: lanjut ke P8+ atau berhenti.**

**FASE F — Phase 8 + 9 · M4 Usable, M5 Safe.** `P8-01`…`P8-08`, `P9-01`…`P9-07`
Daemon WS + JSON-RPC + token auth (expert: `P8-04`), SDK, CLI, lalu RiskClassifier (expert), PermissionGate, HumanGate,
audit, suite prompt-injection, canary secret e2e. Gate G4 (keamanan daemon) dan G5 (checklist S1–S20) menyusul.

**FASE G — Phase 10 + 11 + 12 · M6 Measured, M7 v0.1.0.** `P10-*`, `P11-*`, `P12-*`
Benchmark harness + ablation (mode A/B/C) → verdict H1–H4; compatibility hardening (OOPIF expert, multi-tab, MFA e2e,
stack Keycloak self-hosted); packaging + MVP acceptance → tag **v0.1.0** (COMPATIBILITY.md §4 terisi).

---

## 8. Aturan kerja yang kupatuhi (dipaksakan `docs/CODING_AGENT.md`)

1. Satu task per perubahan. Tidak "sekalian mengerjakan yang sebelah".
2. Test dari kartu task wajib ada dan lulus; verifikasi: `pnpm build && pnpm -r typecheck && pnpm lint && pnpm test` (+ test browser/e2e yang disebut kartu).
3. Tidak ada dependency baru di luar `playwright-core`, `better-sqlite3`, `ws`, `zod` tanpa ADR.
4. Batas package dihormati: Playwright hanya di `browser`, SQLite hanya di `memory`, detail vendor LLM hanya di `ai` (dijaga `P0-02`).
5. Tidak ada LLM call di jalur deterministik; tidak ada screenshot di luar tier vision; secret tidak pernah masuk SQLite/log/prompt/event.
6. Tidak pernah bypass CAPTCHA/MFA/passkey/bot detection; challenge → `WAITING_FOR_HUMAN`.
7. Tidak pernah menunjuk profil Chrome/Edge default user.
8. Kalau kartu task bertentangan dengan arsitektur: **berhenti**, tulis entri di `docs/tasks/CONFLICTS.md`, tandai `blocked`. Tidak memilih sisi sendiri.
9. Status task diupdate di `docs/tasks/README.md`; laporan akhir pakai format `docs/CODING_AGENT.md` §10.
10. Commit pakai DCO sign-off (`git commit -s`).
11. **Tidak menyalin kode pihak ketiga** tanpa izin eksplisit di kartu task + prosedur `OSS_STRATEGY.md` §5 (lihat §4).
12. Perubahan hot path disertai angka benchmark sebelum/sesudah.

## 9. Yang menunggu pemilik (bukan blocker teknis)

- Konfirmasi izin employer sebelum push publik pertama (Apache-2.0 — sudah tercatat di CONFLICTS.md).
- Remote GitHub, supaya `P0-03` bisa naik dari `review` ke `done`.
- Keputusan G2 (bentuk observasi) dan G3 (lanjut/stop setelah tesis terbukti).
- Target situs nyata + akun uji milik sendiri (ADR-019) — belum dibutuhkan sampai Fase G.
- Izin tertulis IT/security bila kelak ingin mengetes tenant employer (sekarang: out of scope).

## 10. Langkah berikutnya

**FASE A selesai, GATE G0 lulus.** Lanjutannya berurutan; gate G2/G3 tetap milik pemilik, FASE B/C tidak. Gate G0 sudah lewat.

1. **FASE B — Phase 1 `P1-01`…`P1-04`** (`packages/protocol`): ids + `BosError`, tipe `specs/data-models.md`,
   zod schema + tabel method RPC, lalu `mask.ts`/EventBus/paths/target syntax. Semua package lain menunggu ini.
   Perhatikan `SENSITIVE_NAME_RE` — satu-satunya sumber regex sensitivitas (integration §2).
2. Jalur paralel yang aman karena package berbeda: **`P5-01`…`P5-04`** (`ai`, FakeModel dulu, tanpa API key) dan
   **`P6-01`…`P6-04`** (`memory`, better-sqlite3 — ingat `allowBuilds` di `pnpm-workspace.yaml`, lihat CONFLICTS.md).
3. **FASE C** (`P2`, `P3`) baru setelah FASE B, karena `PageDriver` memakai tipe `protocol`.

Yang masih menunggu pemilik dan tidak menghalangi FASE B: remote GitHub (untuk menaikkan `P0-03` dari `review` ke `done`),
izin employer sebelum push publik, dan keputusan di gate G2/G3.