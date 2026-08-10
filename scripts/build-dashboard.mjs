// Gera o painel de entregas da UNIUBE a partir do ClickUp, sem usar IA.
// Roda no GitHub Actions (Node 18+, tem fetch nativo). Sem dependências externas.
//
// O que faz:
//  1. Busca todas as tarefas da lista "Priority [ Marketing ]" no ClickUp.
//  2. Filtra as que pertencem à UNIUBE e foram criadas nos últimos 3 meses.
//  3. Para cada uma, busca os comentários e extrai links do Google Drive
//     (da descrição e dos comentários) — nunca o texto dos comentários em si.
//  4. Limpa a descrição de forma conservadora (remove emojis/markdown e corta
//     antes de qualquer trecho que pareça instrução interna de produção).
//     Se não sobrar nada seguro, usa um texto genérico — nunca expõe bruto.
//  5. Gera index.html (o mesmo design do protótipo) com os dados atualizados.

const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const LIST_ID = "901318848330"; // "Priority [ Marketing ]"
const CLIENT_MATCH = /uniube/i;
const DAYS_WINDOW = 90;

if (!CLICKUP_TOKEN) {
  console.error("Faltou a variável de ambiente CLICKUP_API_TOKEN.");
  process.exit(1);
}

const API = "https://api.clickup.com/api/v2";

async function cuFetch(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: CLICKUP_TOKEN },
  });
  if (!res.ok) {
    throw new Error(`ClickUp API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getAllTasks() {
  let page = 0;
  let all = [];
  while (true) {
    const data = await cuFetch(
      `/list/${LIST_ID}/task?include_closed=true&subtasks=true&page=${page}`
    );
    all = all.concat(data.tasks || []);
    if (!data.tasks || data.tasks.length === 0 || data.last_page) break;
    page += 1;
    if (page > 30) break; // salvaguarda
  }
  return all;
}

const DRIVE_RE = /https?:\/\/(?:www\.)?drive\.google\.com\/[^\s)\]"'<>]+/gi;

function extractDriveLinks(...texts) {
  const found = new Set();
  for (const t of texts) {
    if (!t) continue;
    const matches = t.match(DRIVE_RE) || [];
    for (let m of matches) {
      m = m.replace(/[.,;:)\]]+$/, "");
      found.add(m);
    }
  }
  return [...found];
}

// Linhas que batem com qualquer um desses padrões são descartadas (não cortamos
// a descrição inteira no primeiro achado — só removemos as linhas internas,
// já que o cabeçalho "FLUXO DE TRABALHO" costuma vir sempre na primeira linha
// de todo briefing e cortar ali deixaria a descrição sempre vazia).
const INTERNAL_LINE_PATTERNS = [
  /fluxo de trabalho/i,
  /prioridade\s*:/i,
  /zona[s]? de seguran[çc]a/i,
  /alerta de grid/i,
  /grid interativo/i,
  /direcionamento de (design|reda[çc][ãa]o|copy)/i,
  /especifica[çc][õo]es de cria[çc][ãa]o/i,
  /entreg[áa]veis esperados/i,
  /observa[çc][õo]es e notas/i,
  /status\s*\/\s*notas importantes/i,
  /copywriter/i,
  /parte\s*\d+\s*[:\-]/i,
  /unidade\s*\/\s*localiza[çc][ãa]o/i,
  /modalidades ofertadas/i,
  /formatos exigidos/i,
  /perfil do p[úu]blico/i,
  /fonte dos cursos/i,
  /linha de argumenta[çc][ãa]o/i,
  /padr[ãa]o institucional/i,
  /dire[çc][ãa]o de arte/i,
  /destaques de arte/i,
  /hierarquia visual/i,
  /p[úu]blico[- ]alvo/i,
  /p[úu]blico principal/i,
  /p[úu]blico que pode ser impactado/i,
  /chamada para a[çc][ãa]o\s*\(cta\)/i,
  /etapa do funil/i,
  /kpi principal/i,
  /gancho individualizado/i,
  /diferencia[çc][ãa]o de modalidade/i,
  /ancoragem local/i,
  /^https?:\/\//i,
  /^drive\.google\.com/i,
];

// Quando existir uma linha "Objetivo Estratégico:" ou "Objetivo:", usamos
// exatamente esse trecho como resumo — é o campo que mais se parece com uma
// explicação neutra do que está sendo entregue.
const OBJECTIVE_LABELS = [
  /objetivo\s*estrat[ée]gico\s*:\s*(.+)/i,
  /objetivo\s*:\s*(.+)/i,
];

const FALLBACK_TEXT =
  "Demanda em produção — detalhes completos disponíveis com a equipe da Somos Young.";

function stripEmojiAndMarkdown(text) {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/gu, "")
    .replace(/^>+\s?/gm, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\[[^\]]*\]\((https?:[^)]+)\)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function capLength(text) {
  let result = text.trim();
  if (result.length > 320) {
    result = result.slice(0, 320).replace(/\s+\S*$/, "") + "…";
  }
  return result;
}

function cleanDescription(raw) {
  if (!raw) return FALLBACK_TEXT;
  const text = stripEmojiAndMarkdown(raw);
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[*\-•\d.\s]+/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    for (const re of OBJECTIVE_LABELS) {
      const m = line.match(re);
      if (m && m[1].trim().length > 8) {
        return capLength(m[1].trim());
      }
    }
  }

  const safeLines = lines.filter(
    (line) => !INTERNAL_LINE_PATTERNS.some((re) => re.test(line))
  );
  const result = capLength(safeLines.join(" "));
  if (result.length < 15) return FALLBACK_TEXT;
  return result;
}

function cleanName(rawName) {
  return rawName
    .replace(/^\s*\[?\s*uniube\s*\]?\s*[-–—:]?\s*/i, "")
    .trim();
}

const STATUS_MAP = {
  "a fazer": "todo",
  "em produção": "doing",
  bloqueado: "blocked",
  concluído: "done",
  finalizado: "done",
};

async function main() {
  const all = await getAllTasks();
  const cutoff = Date.now() - DAYS_WINDOW * 24 * 60 * 60 * 1000;

  const candidates = all.filter(
    (t) => CLIENT_MATCH.test(t.name) && Number(t.date_created) >= cutoff
  );

  console.log(`Tarefas UNIUBE dentro da janela de ${DAYS_WINDOW} dias: ${candidates.length}`);

  const tasks = [];
  for (const t of candidates) {
    let comments = [];
    try {
      const c = await cuFetch(`/task/${t.id}/comment`);
      comments = c.comments || [];
    } catch (e) {
      console.error(`Falha ao buscar comentários de ${t.id}:`, e.message);
    }
    const commentTexts = comments.map((c) => c.comment_text || "");
    const driveLinks = extractDriveLinks(t.description || t.text_content || "", ...commentTexts);
    const bucket = STATUS_MAP[(t.status?.status || "").toLowerCase()] || "todo";

    tasks.push({
      id: t.id,
      name: cleanName(t.name),
      status: t.status?.status || "",
      bucket,
      date_created: Number(t.date_created),
      summary: cleanDescription(t.description || t.text_content || ""),
      drive_links: driveLinks,
    });
  }

  tasks.sort((a, b) => b.date_created - a.date_created);
  renderHtml(tasks);
}

function renderHtml(tasks) {
  const STATUS_META = {
    todo: { label: "A Fazer", color: "var(--st-todo)", icon: "○" },
    doing: { label: "Em Produção", color: "var(--st-doing)", icon: "◐" },
    blocked: { label: "Bloqueado", color: "var(--st-blocked)", icon: "⚠" },
    done: { label: "Concluído", color: "var(--st-done)", icon: "✓" },
  };
  const COLUMN_ORDER = ["todo", "doing", "blocked", "done"];

  const total = tasks.length;
  const done = tasks.filter((t) => t.bucket === "done").length;
  const blocked = tasks.filter((t) => t.bucket === "blocked").length;
  const active = tasks.filter((t) => t.bucket !== "done").length;

  const todayStr = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const html = TEMPLATE
    .replace(/__TASKS_JSON__/g, JSON.stringify(tasks))
    .replace(/__STATUS_META_JSON__/g, JSON.stringify(STATUS_META))
    .replace(/__COLUMN_ORDER_JSON__/g, JSON.stringify(COLUMN_ORDER))
    .replace(/__TOTAL__/g, total)
    .replace(/__ACTIVE__/g, active)
    .replace(/__BLOCKED__/g, blocked)
    .replace(/__DONE__/g, done)
    .replace(/__UPDATED__/g, todayStr);

  fs.writeFileSync(new URL("../index.html", import.meta.url), html, "utf-8");
  console.log(`index.html gerado — ${total} demandas (${active} em andamento, ${blocked} bloqueadas, ${done} concluídas).`);
}

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = fs.readFileSync(path.join(__dirname, "template.html"), "utf-8");

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
