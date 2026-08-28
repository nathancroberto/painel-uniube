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

// Pega links de Drive (pastas/arquivos) e também de Docs/Sheets/Slides/Forms,
// que no Google ficam todos sob o domínio docs.google.com. O time também
// costuma colar o link nos comentários sem o "https://" na frente (ex.:
// "drive.google.com/drive/folders/..."), então o protocolo é opcional aqui —
// sem isso, esses links ficavam de fora e o card do cliente aparecia sem
// nenhum arquivo pra abrir.
const DRIVE_RE = /(?:https?:\/\/)?(?:www\.)?(?:drive|docs)\.google\.com\/[^\s)\]"'<>]+/gi;

function findDriveUrls(text) {
  if (!text) return [];
  const matches = text.match(DRIVE_RE) || [];
  return matches.map((m) => {
    m = m.replace(/[.,;:)\]]+$/, "");
    if (!/^https?:\/\//i.test(m)) m = `https://${m}`;
    return m;
  });
}

// Equipe da agência (nomes do workspace do ClickUp) — usado pra remover
// menções ("@Fulano de Tal") de forma exata. Uma correspondência exata evita
// um bug sério: um padrão só baseado em maiúscula ("@Vinicius Diaz Segue...")
// acabava engolindo a primeira palavra da frase seguinte também, porque ela
// também começa com maiúscula.
const KNOWN_TEAM_NAMES = [
  "Matheus Monteiro Furbino e Souza",
  "Marco Aurelio Pereira da Cunha",
  "Ana Cláudia Novais dos Santos",
  "Lucas Henrique de Matos Pereira",
  "Yasmin Fernanda Lopes Santos",
  "Amanda Silveira Lima Costa",
  "Gustavo Domingues dos Santos",
  "Kaio Pereira Onofre Viveiros",
  "Aline Sayuri de Bastiani",
  "Nathália Duarte Ballesteros",
  "Jonathas Batista Leal",
  "João Lucas Carvalho",
  "Rafael José Michelon",
  "Andriela Modinuti",
  "Otavio Lopes",
  "Patrick Bonnereau",
  "Bruno Baccan",
  "Andréa Silva Lima",
  "Érika Gonçalves",
  "Nathan Cardoso",
  "Vinicius Diaz",
  "Lucas Neres",
  "Pedro Barreto",
  "Helder Brito",
  "Renã Pedroso",
  "Álvaro Fernando",
  "Sara Carsalade",
  "Vitor Augusto",
  "Denis Medeiros",
  "Bruno Trindade",
  "Somos Young",
  "Andriela",
  "Tolky",
].sort((a, b) => b.length - a.length);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const KNOWN_MENTION_RE = new RegExp(
  "@(?:" + KNOWN_TEAM_NAMES.map(escapeRegExp).join("|") + ")",
  "gi"
);

// Rede de segurança pra quem não está na lista acima (alguém que saiu da
// equipe ou entrou depois desta lista ser gerada): assume no máximo
// "@Nome Sobrenome" (2 palavras), pra reduzir o risco de engolir a primeira
// palavra maiúscula da frase seguinte.
const FALLBACK_MENTION_RE = /@\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?/gu;

// Constrói uma legenda curta e segura a partir do texto de um comentário —
// a mesma orientação que a pessoa escreveu ao compartilhar o arquivo (ex.:
// "Segue, últimos 3 cursos de Negócios..." ou "Os textos estão na aba
// 'Parceiros'."), sem menções, sem o link em si, e sem nenhuma linha de
// jargão interno de produção. Se não sobrar nada seguro, não tem legenda.
function cleanCaption(raw) {
  if (!raw) return null;
  let text = raw.replace(/^undefined/, ""); // artefato do ClickUp quando o comentário é só um card anexado
  text = stripEmojiAndMarkdown(text);
  text = text.replace(KNOWN_MENTION_RE, "");
  text = text.replace(FALLBACK_MENTION_RE, "");
  text = text.replace(DRIVE_RE, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const safeLines = lines.filter(
    (line) => !INTERNAL_LINE_PATTERNS.some((re) => re.test(line))
  );
  const joined = safeLines.join(" ").replace(/\s{2,}/g, " ").trim();
  const cleaned = joined
    .replace(/^[:\-–—,\s]+/, "")
    .replace(/[:\-–—,\s]+$/, "")
    .trim();
  if (cleaned.length < 4) return null;
  return capLength(cleaned, 180);
}

// Legenda só faz sentido pra link de Doc/Sheet/Slide/Form (docs.google.com):
// nesse caso o nome do arquivo sozinho não diz muito, então a orientação de
// quem compartilhou ajuda o cliente a entender o que vai encontrar lá. Já um
// link de pasta/arquivo do Drive já é auto-explicativo (o cliente abre e vê
// o material) — não precisa de legenda.
function isDocsLink(url) {
  return /^https?:\/\/(www\.)?docs\.google\.com/i.test(url);
}

// Retorna [{ url, caption }] combinando links da descrição (sem legenda) com
// links encontrados nos comentários (com a orientação de quem compartilhou,
// só para links de Docs/Sheets). Também escaneia o comentário inteiro
// serializado, não só o comment_text: quando alguém anexa um Google Doc/Sheet
// como card (embed) em vez de colar a URL como texto puro, o link fica
// dentro do objeto de anexo — e o comment_text vira só "undefined" + o texto
// que a pessoa digitou.
function collectDriveLinks(descriptionText, comments) {
  const linkMap = new Map(); // url -> caption (string | null)

  for (const url of findDriveUrls(descriptionText)) {
    if (!linkMap.has(url)) linkMap.set(url, null);
  }

  for (const c of comments) {
    const rawText = c.comment_text || "";
    let rawFull = "";
    try {
      rawFull = JSON.stringify(c);
    } catch {
      // ignora comentário que não serializa (não deveria acontecer)
    }
    const urls = new Set([...findDriveUrls(rawText), ...findDriveUrls(rawFull)]);
    if (urls.size === 0) continue;
    const caption = cleanCaption(rawText);
    for (const url of urls) {
      const captionForUrl = isDocsLink(url) ? caption : null;
      if (!linkMap.has(url) || !linkMap.get(url)) {
        linkMap.set(url, captionForUrl);
      }
    }
  }

  return [...linkMap.entries()].map(([url, caption]) => ({ url, caption }));
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
  /^(drive|docs)\.google\.com/i,
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

function capLength(text, max) {
  let result = text.trim();
  if (result.length > max) {
    result = result.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }
  return result;
}

// Retorna { summary, full }: "summary" é o teaser curto (uma linha só, para o
// card), "full" é o texto completo mostrado ao clicar na tarefa — já limpo de
// jargão interno, mas preservando quebras de linha e marcadores de lista para
// não virar um bloco único de texto. Nunca é o texto bruto do ClickUp.
function cleanDescription(raw) {
  if (!raw) return { summary: FALLBACK_TEXT, full: FALLBACK_TEXT };
  const text = stripEmojiAndMarkdown(raw);

  // Guarda se a linha era um item de lista (bullet ou numerada) antes de tirar
  // o marcador, pra poder recolocar um "• " consistente no texto final.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const isBullet = /^[*\-•]\s+/.test(l) || /^\d+[.)]\s+/.test(l);
      const clean = l.replace(/^[*\-•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
      return { text: clean, isBullet };
    })
    .filter((l) => l.text.length > 0);

  for (const { text: line } of lines) {
    for (const re of OBJECTIVE_LABELS) {
      const m = line.match(re);
      if (m && m[1].trim().length > 8) {
        const clean = m[1].trim();
        return { summary: capLength(clean, 220), full: capLength(clean, 4000) };
      }
    }
  }

  const safeLines = lines.filter(
    ({ text: line }) => !INTERNAL_LINE_PATTERNS.some((re) => re.test(line))
  );

  const summaryText = safeLines.map((l) => l.text).join(" ").trim();
  if (summaryText.length < 15) return { summary: FALLBACK_TEXT, full: FALLBACK_TEXT };

  // Junta parágrafos normais com linha em branco entre eles (fica mais
  // arejado) e itens de lista com quebra simples, prefixados por "•".
  const fullParts = [];
  let bulletBuffer = [];
  const flushBullets = () => {
    if (bulletBuffer.length) {
      fullParts.push(bulletBuffer.map((t) => `• ${t}`).join("\n"));
      bulletBuffer = [];
    }
  };
  for (const l of safeLines) {
    if (l.isBullet) {
      bulletBuffer.push(l.text);
    } else {
      flushBullets();
      fullParts.push(l.text);
    }
  }
  flushBullets();
  const fullText = fullParts.join("\n\n").trim();

  return { summary: capLength(summaryText, 220), full: capLength(fullText, 4000) };
}

function cleanName(rawName) {
  return rawName
    .replace(/^\s*\[?\s*uniube\s*\]?\s*[-–—:]?\s*/i, "")
    .trim();
}

// "a fazer" entra junto de "em produção" de propósito: o cliente não deve ver
// uma coluna vazia/"parado" só porque a peça ainda não começou a ser feita.
// "em revisão" e "revisado" ganham coluna própria "Em Revisão" (etapa de
// checagem interna, antes de ir pro cliente).
// "aguardando cliente" ganha coluna própria "Aguardando Aprovação": é o único
// status onde a próxima ação é do próprio cliente, então vale destacar.
// "aprovado cliente" conta como concluído: se o cliente já aprovou, não sobra
// nada pendente do lado dele.
const STATUS_MAP = {
  "a fazer": "doing",
  "em produção": "doing",
  "em revisão": "review",
  revisado: "review",
  bloqueado: "blocked",
  "aguardando cliente": "waiting",
  "aprovado cliente": "done",
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
    const driveLinks = collectDriveLinks(t.description || t.text_content || "", comments);
    const bucket = STATUS_MAP[(t.status?.status || "").toLowerCase()] || "doing";

    const { summary, full } = cleanDescription(t.description || t.text_content || "");

    tasks.push({
      id: t.id,
      name: cleanName(t.name),
      status: t.status?.status || "",
      bucket,
      date_created: Number(t.date_created),
      summary,
      full_description: full,
      drive_links: driveLinks,
    });
  }

  tasks.sort((a, b) => b.date_created - a.date_created);
  renderHtml(tasks);
}

function renderHtml(tasks) {
  const STATUS_META = {
    doing: { label: "Em Produção", color: "var(--st-doing)", icon: "◐" },
    review: { label: "Em Revisão", color: "var(--st-review)", icon: "🔍" },
    waiting: { label: "Aguardando Aprovação", color: "var(--st-waiting)", icon: "⏳" },
    blocked: { label: "Bloqueado", color: "var(--st-blocked)", icon: "⚠" },
    done: { label: "Concluído", color: "var(--st-done)", icon: "✓" },
  };
  const COLUMN_ORDER = ["doing", "review", "waiting", "blocked", "done"];

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
