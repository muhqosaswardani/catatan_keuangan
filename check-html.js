/**
 * check-html.js
 * Validasi struktur HTML index.html:
 * - Semua <div class="page" id="page-*"> harus siblings (kedalaman sama)
 * - Tidak boleh ada </div> nyasar yang menutup container induk kepagian
 *
 * Dijalankan otomatis via Git pre-commit hook.
 * Bisa juga dijalankan manual: node check-html.js
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'index.html');

if (!fs.existsSync(FILE)) {
  console.error('[check-html] index.html tidak ditemukan!');
  process.exit(1);
}

const raw = fs.readFileSync(FILE, 'utf8');

// --- 1. Strip HTML comments (<!-- ... -->) agar div di dalamnya tidak dihitung ---
const stripped = raw.replace(/<!--[\s\S]*?-->/g, (match) => {
  // Ganti dengan whitespace sepanjang yang sama agar line numbers tetap valid
  return match.replace(/[^\n]/g, ' ');
});

const lines = stripped.split('\n');

// --- 2. Hitung kedalaman div di setiap baris ---
let depth = 0;
const depthAtLine = []; // depthAtLine[i] = depth SEBELUM baris i diproses

for (let i = 0; i < lines.length; i++) {
  depthAtLine[i] = depth;
  const l = lines[i];
  const opens = (l.match(/<div[\s>]/gi) || []).length;
  const closes = (l.match(/<\/div>/gi) || []).length;
  depth += opens - closes;
}

// --- 3. Cari semua .page div dan catat kedalamannya ---
const pageRegex = /<div[^>]+class="page"[^>]+id="page-([^"]+)"/g;
const rawLines = raw.split('\n');
const pageFindings = [];

for (let i = 0; i < rawLines.length; i++) {
  const l = rawLines[i];
  let m;
  const re = /<div[^>]+class="page"[^>]+id="page-([^"]+)"/g;
  while ((m = re.exec(l)) !== null) {
    pageFindings.push({ lineNum: i + 1, pageId: m[1], depth: depthAtLine[i] });
  }
}

// --- 4. Validasi: semua .page harus di depth yang sama ---
let errors = [];

if (pageFindings.length === 0) {
  errors.push('Tidak ada div.page yang ditemukan di index.html!');
} else {
  const expectedDepth = pageFindings[0].depth;
  for (const p of pageFindings) {
    if (p.depth !== expectedDepth) {
      errors.push(
        `[line ${p.lineNum}] #page-${p.pageId} ada di kedalaman div ${p.depth}, ` +
        `tapi seharusnya ${expectedDepth} (sama dengan #page-${pageFindings[0].pageId} di line ${pageFindings[0].lineNum}). ` +
        `Ada </div> nyasar sebelum page ini!`
      );
    }
  }
}

// --- 5. Validasi: balance div keseluruhan harus >= 0 (tidak negatif di tengah) ---
let runningDepth = 0;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  const opens = (l.match(/<div[\s>]/gi) || []).length;
  const closes = (l.match(/<\/div>/gi) || []).length;
  runningDepth += opens - closes;
  if (runningDepth < 0) {
    errors.push(
      `[line ${i + 1}] Kedalaman div menjadi negatif (${runningDepth})! ` +
      `Ada </div> ekstra yang tidak punya pasangan <div>.\n` +
      `  Baris: ${rawLines[i].trim().substring(0, 80)}`
    );
    break; // cukup laporkan yang pertama
  }
}

// --- 6. Output ---
if (errors.length > 0) {
  console.error('\n❌ [check-html] Ditemukan masalah struktur HTML di index.html:\n');
  errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}\n`));
  console.error(
    '💡 Cara fix: Cari </div> ekstra di area yang dilaporkan dan hapus.\n' +
    '   Bug klasik: </div> nyasar setelah blok page-settings menutup container\n' +
    '   induk (#app) kepagian, bikin page-laporan/page-chat tampak blank.\n'
  );
  process.exit(1); // Exit code 1 = tolak commit
} else {
  console.log(`✅ [check-html] Struktur HTML OK. ${pageFindings.length} page div ditemukan, semua di kedalaman ${pageFindings[0]?.depth}.`);
  process.exit(0);
}
