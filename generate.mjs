// Affinity 먼데이 매칭 뷰 — 정적 HTML 생성기 (의존성 없음, Node 20+)
// 4개 뷰(수강생 / 강사 스케줄[주간+월간] / 이탈 / 종강)를 먼데이 API에서 가져와 docs/index.html 로 출력.
// 토큰은 .env(로컬) 또는 환경변수 MONDAY_API_TOKEN(GitHub Actions Secret) 에서 읽습니다.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(ROOT, "docs");

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const TOKEN = (process.env.MONDAY_API_TOKEN || "").trim();
if (!TOKEN) {
  console.error("MONDAY_API_TOKEN 이 없습니다 (.env 또는 환경변수/Secret).");
  process.exit(1);
}

// 페이지 접근 비밀번호. 데이터는 이 비밀번호로 암호화되어, 입력 시에만 복호화됩니다.
const VIEW_PASSWORD = (process.env.VIEW_PASSWORD || "5000").trim();

const INSTRUCTOR_NAME_MAP = {};
const INSTRUCTOR_ORDER = ["ZOEY", "HANNAH", "SION", "SYEON", "SHU", "SEONYE", "AYEONG", "ONYU", "RARA", "JIMIN", "DOORI"];

const STUDENT_BOARD = "1879266175";
const CLASS_BOARD = "1888467610";
const DONE_GROUP_TITLE = "DONE";
const WEEKDAYS = [
  { key: "MON", label: "월" },
  { key: "TUE", label: "화" },
  { key: "WED", label: "수" },
  { key: "THU", label: "목" },
  { key: "FRI", label: "금" },
  { key: "SAT", label: "토" },
];
const MONTH_DOW = ["일", "월", "화", "수", "목", "금", "토"];

const N = (t) => (t == null ? "" : String(t).replace(/\s+/g, " ").trim());
const esc = (s) => N(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (s) => esc(s).replace(/'/g, "&#39;");
const stripFlag = (s) => N(s).replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\s]+/u, "").trim();
const normName = (s) => stripFlag(s).split("/")[0].split("(")[0].trim();
const isoOf = (d) => d.toISOString().slice(0, 10);

async function mondayQuery(query) {
  for (let i = 0; i < 5; i += 1) {
    try {
      const res = await fetch("https://api.monday.com/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: TOKEN },
        body: JSON.stringify({ query }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 80)}`);
      }
      if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 200));
      return data.data;
    } catch (err) {
      if (i === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return null;
}

async function fetchBoardItems(boardId, columnIds, subColumnIds = null) {
  const ids = JSON.stringify(columnIds);
  const frags =
    "... on MirrorValue { display_value } ... on BoardRelationValue { display_value } ... on FormulaValue { display_value }";
  const sub = subColumnIds
    ? ` subitems { id name column_values(ids: ${JSON.stringify(subColumnIds)}) { id text } }`
    : "";
  const query = `query { boards(ids: ${boardId}) { name items_page(limit: 500) { items { id name group { id title } column_values(ids: ${ids}) { id text value ${frags} }${sub} } } } }`;
  const data = await mondayQuery(query);
  const board = data?.boards?.[0] || null;
  return { name: board?.name || "", items: board?.items_page?.items || [] };
}

function byId(item) {
  const map = new Map();
  for (const c of item.column_values || []) if (c.id && !map.has(c.id)) map.set(c.id, c);
  return map;
}
const textOf = (m, id) => N(m.get(id)?.text);
function displayOf(m, id) {
  const raw = N(m.get(id)?.display_value);
  return raw && raw !== "null" ? raw : "";
}
function linkOf(m, id) {
  const c = m.get(id);
  if (!c) return "";
  if (typeof c.value === "string" && c.value) {
    try {
      const v = JSON.parse(c.value);
      if (v && N(v.text)) return N(v.text);
      if (v && N(v.url)) return N(v.url);
    } catch {
      /* ignore */
    }
  }
  return N(c.text);
}
// 여러 board_relation(연결) 컬럼의 display_value(수강생 이름)를 하나로 병합한다.
// 두 컬럼에 중복 배정된 학생은 없지만, 안전하게 이름 기준으로 중복 제거한다.
function mergeRelationDisplay(m, ids) {
  const names = [];
  const seen = new Set();
  for (const id of ids) {
    const raw = displayOf(m, id) || textOf(m, id);
    if (!raw) continue;
    for (const part of raw.split(",")) {
      const name = N(part);
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names.join(", ");
}
function parseDates(raw) {
  return Array.from(
    new Set(
      N(raw)
        .split(/[,\n;|]+/)
        .map((t) => (N(t).match(/\d{4}-\d{2}-\d{2}/) || [""])[0])
        .filter(Boolean),
    ),
  ).sort();
}
function timeToMin(raw) {
  const t = N(raw).toUpperCase();
  const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/);
  if (!m) return 1e9;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3] === "PM" && h < 12) h += 12;
  if (m[3] === "AM" && h === 12) h = 0;
  return h * 60 + min;
}
const isAM = (raw) => {
  const min = timeToMin(raw);
  return min < 720;
};
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// 해당 날짜가 속한 주의 월요일(ISO) 반환
function mondayOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=일 … 6=토
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}
// 하위아이템(레슨) 파싱: 이름에 "휴강"이 포함되어 있으면 휴강 날짜로 처리하고,
// 그 외에는 모두 회차(레슨)로 인정한다. "LESSON 01" / "LESSON 001" 처럼 뒤에
// 다른 텍스트가 붙어 있어도(예: "LESSON 08 *결제 안내") 회차 번호만 추출해 사용한다.
const LESSON_NO_RE = /LESSON\s+0*(\d+)/i;
const OFF_KEYWORD_RE = /휴강/;
function parseLessons(it) {
  const lessons = []; // { date, no }
  const offs = []; // iso
  for (const s of it.subitems || []) {
    const m = byId(s);
    const date = (textOf(m, "date65").match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
    if (!date) continue;
    // 이름에서 이모지/플래그 제거
    const clean = N(s.name).replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, "").replace(/\s+/g, " ").trim();
    if (OFF_KEYWORD_RE.test(clean)) {
      offs.push(date);
      continue;
    }
    const lm = clean.match(LESSON_NO_RE);
    lessons.push({ date, no: lm ? parseInt(lm[1], 10) : null });
  }
  return { lessons, offs };
}
function deriveOffDates(dates) {
  if (dates.length < 2) return [];
  const present = new Set(dates);
  const off = [];
  let cur = dates[0];
  const last = dates[dates.length - 1];
  let guard = 0;
  while (cur <= last && guard < 400) {
    if (!present.has(cur)) off.push(cur);
    cur = addDaysIso(cur, 7);
    guard += 1;
  }
  return off;
}

// ── 매핑 ─────────────────────────────────────────────────────
const EXCLUDE_STUDENT_GROUPS = new Set(["기아대책 DB", "DB 정리 요망"]);

function mapStudents(items) {
  const groups = new Map();
  const order = [];
  for (const it of items) {
    const m = byId(it);
    const gTitle = N(it.groupTitle || it.group?.title);
    if (EXCLUDE_STUDENT_GROUPS.has(gTitle)) continue; // 불러오지 않을 그룹
    const g = gTitle || "미분류";
    if (!groups.has(g)) {
      groups.set(g, []);
      order.push(g);
    }
    const enrolled = displayOf(m, "formula_mkv1sj2z") === "1";
    groups.get(g).push({
      name: N(it.name) || "이름 미상",
      status: enrolled ? "수강" : "비수강",
      enrolled,
      birth: "", // 생년월일: 빈칸으로 둔다
      startDate: textOf(m, "date4") || "-",
      marketer: textOf(m, "color_mknkc0rw") || "-",
      region: textOf(m, "text_mknkvpaq") || "-",
      record: linkOf(m, "link") || "-",
      contact: textOf(m, "text_mktj6gkp") || "-",
      email: textOf(m, "text_mksvtgc8") || "-",
    });
  }
  return order.map((title) => ({ title, rows: groups.get(title) }));
}

function mapClass(it) {
  const m = byId(it);
  const group = N(it.groupTitle || it.group?.title);
  const hab = displayOf(m, "formula_mkzy2qad");

  // 날짜·회차: 하위아이템(레슨)에서 직접 구성. 하위아이템이 없으면 미러(TIMELINE)로 폴백.
  const { lessons, offs } = parseLessons(it);
  let dates;
  let offDates;
  const lessonByDate = {};
  if (lessons.length || offs.length) {
    for (const l of lessons) lessonByDate[l.date] = l.no;
    dates = Array.from(new Set(lessons.map((l) => l.date))).sort();
    offDates = Array.from(new Set(offs)).sort();
  } else {
    dates = parseDates(displayOf(m, "lookup") || textOf(m, "lookup"));
    offDates = deriveOffDates(dates);
  }

  return {
    name: N(it.name) || "이름 없음",
    group,
    instructor: textOf(m, "project_owner"),
    length: textOf(m, "color_mm07m65v"),
    startTime: textOf(m, "hour"),
    startMin: timeToMin(textOf(m, "hour")),
    habruta: hab === "0" ? "" : hab,
    assistant: textOf(m, "multiple_person_mkywhxez"),
    students: mergeRelationDisplay(m, ["board_relation_mkss72aq", "board_relation_mm52z2sq"]),
    dates,
    lessonByDate,
    startDate: dates[0] || "",
    endDate: dates[dates.length - 1] || "",
    offDates,
  };
}

function mapWeekdayClasses(classItems) {
  const wd = new Set(WEEKDAYS.map((d) => d.key));
  return classItems.map(mapClass).filter((c) => wd.has(c.group.toUpperCase()) && c.dates.length > 0);
}

function mapCompleted(classItems) {
  return classItems
    .map(mapClass)
    .filter((c) => N(c.group).toUpperCase() === DONE_GROUP_TITLE)
    .sort((a, b) => (b.endDate || "").localeCompare(a.endDate || "") || a.startMin - b.startMin);
}

// project_owner 가 "A, B" 처럼 2명이면 각각의 개별 강사로 분리.
function splitInstructors(text) {
  const names = N(text).split(",").map((s) => { const n = N(s); return INSTRUCTOR_NAME_MAP[n] || n; }).filter(Boolean);
  return names.length ? names : ["미배정"];
}

function summarizeInstructors(classes) {
  const counts = new Map();
  for (const c of classes) for (const name of splitInstructors(c.instructor)) counts.set(name, (counts.get(name) || 0) + 1);
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── 렌더 ─────────────────────────────────────────────────────
function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => `<tr${r.inst != null ? ` data-inst='${attr(r.inst)}'` : ""}>${r.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${headers.length}" class="empty">데이터 없음</td></tr>`}</tbody></table></div>`;
}

function renderStudents(groups) {
  const total = groups.reduce((s, g) => s + g.rows.length, 0);
  const enrolled = groups.reduce((s, g) => s + g.rows.filter((r) => r.enrolled).length, 0);
  let html = `<p class="meta">총 ${total}명 · 수강 ${enrolled} · 비수강 ${total - enrolled}</p>`;
  for (const g of groups) {
    html += `<h3 class="grp">${esc(g.title)} <span>${g.rows.length}명</span></h3>`;
    html += table(
      ["수강생", "상태", "생년월일", "시작일", "마케터", "지역", "스튜던트 레코드", "연락처", "이메일"],
      g.rows.map((r) => ({
        cells: [
          `<strong>${esc(r.name)}</strong>`,
          `<span class="badge ${r.enrolled ? "on" : ""}">${esc(r.status)}</span>`,
          esc(r.birth) || "-",
          esc(r.startDate),
          esc(r.marketer),
          esc(r.region),
          esc(r.record),
          esc(r.contact),
          esc(r.email),
        ],
      })),
    );
  }
  return html;
}

function instructorFilterBar(instructors, total) {
  const ordered = instructors.slice().sort((a, b) => {
    const ai = INSTRUCTOR_ORDER.indexOf(a.name);
    const bi = INSTRUCTOR_ORDER.indexOf(b.name);
    if (ai < 0 && bi < 0) return a.name.localeCompare(b.name);
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  });
  let html = `<div class="filter"><span class="flabel">강사 필터</span><button class="chip active" data-filter-inst="">전체 <b>${total}</b></button>`;
  for (const i of ordered) html += `<button class="chip" data-filter-inst="${attr(i.name)}">${esc(i.name)} <b>${i.count}</b></button>`;
  return `${html}</div>`;
}

// 주간: 한 달치(1주차~5주차)를 주 단위로 넘겨보는 뷰. 각 요일 헤더에 실제 날짜를 표기하고,
// 그 날짜에 해당하는 레슨만 표시한다(다음 주/다음 달은 넘기기 전까지 보이지 않음).
function renderWeekly(classes, todayIso) {
  const byDate = new Map();
  const ensure = (iso) => {
    if (!byDate.has(iso)) byDate.set(iso, { active: [], off: [] });
    return byDate.get(iso);
  };
  let min = null;
  let max = null;
  for (const c of classes) {
    for (const iso of c.dates) {
      ensure(iso).active.push(c);
      if (!min || iso < min) min = iso;
      if (!max || iso > max) max = iso;
    }
    for (const iso of c.offDates) ensure(iso).off.push(c);
  }
  if (!min) return `<p class="empty">표시할 일정이 없습니다.</p>`;

  // min~max 를 덮는 월요일 목록
  const weeks = [];
  let wk = mondayOf(min);
  const lastMon = mondayOf(max);
  let guard = 0;
  while (wk <= lastMon && guard < 260) {
    weeks.push(wk);
    wk = addDaysIso(wk, 7);
    guard += 1;
  }
  const curMon = mondayOf(todayIso);
  let startIdx = weeks.indexOf(curMon);
  if (startIdx < 0) startIdx = weeks.findIndex((w) => w >= curMon);
  if (startIdx < 0) startIdx = weeks.length - 1;

  let html = `<div class="monthnav"><button id="wprev" class="navbtn">이전</button><strong id="wlabel"></strong><button id="wnext" class="navbtn">다음</button></div>`;
  html += `<div id="weeks" data-start="${startIdx}">`;
  weeks.forEach((mon, idx) => {
    const monDay = parseInt(mon.slice(8, 10), 10);
    const kOfMonth = Math.floor((monDay - 1) / 7) + 1;
    const end = addDaysIso(mon, 5);
    const label = `${mon.slice(0, 4)}.${mon.slice(5, 7)} ${kOfMonth}주차 (${mon.slice(5, 7)}.${mon.slice(8, 10)}~${end.slice(5, 7)}.${end.slice(8, 10)})`;
    let grid = `<div class="week">`;
    WEEKDAYS.forEach((d, di) => {
      const iso = addDaysIso(mon, di);
      const entry = byDate.get(iso);
      const dd = parseInt(iso.slice(8, 10), 10);
      grid += `<div class="daycol"><div class="dayhead${iso === todayIso ? " today" : ""}">${d.label} <span>${dd}일</span></div>`;
      const act = (entry ? entry.active : []).slice().sort((a, b) => a.startMin - b.startMin);
      const offl = entry ? entry.off : [];
      if (act.length === 0 && offl.length === 0) grid += `<p class="empty">·</p>`;
      for (const c of act) {
        const no = c.lessonByDate[iso];
        grid += `<div class="card${isAM(c.startTime) ? " am" : ""}" data-inst='${attr(splitInstructors(c.instructor).join("|"))}'><div class="ctime"><strong>${esc(c.startTime || "시간미정")}</strong><span>${esc(c.length)}</span></div>
          <div class="cname">${esc(c.name)}</div>
          <div class="ctags">${no ? `<span class="tag lesson">${no}강</span>` : ""}<span class="tag inst">${esc(c.instructor || "미배정")}</span>${c.habruta ? `<span class="tag">하브루타 ${esc(c.habruta)}</span>` : ""}${c.assistant ? `<span class="tag">보조 ${esc(c.assistant)}</span>` : ""}</div>
          ${c.students ? `<div class="cstu">${esc(c.students)}</div>` : ""}</div>`;
      }
      for (const c of offl) {
        grid += `<div class="card off" data-inst='${attr(splitInstructors(c.instructor).join("|"))}'><div class="cname">휴강</div><div class="ctags"><span class="tag inst">${esc(c.instructor || "미배정")}</span></div><div class="cstu">${esc(c.name)}</div></div>`;
      }
      grid += `</div>`;
    });
    grid += `</div>`;
    html += `<div class="wk" data-week="${idx}" data-label="${attr(label)}" style="display:${idx === startIdx ? "block" : "none"}">${grid}</div>`;
  });
  html += `</div>`;
  return html;
}

function buildMonthGrid(year, month) {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) cells.push(null);
  for (let d = 1; d <= days; d += 1) cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function renderMonthly(classes, current) {
  // 날짜별 active/off 수집
  const byDate = new Map();
  const ensure = (iso) => {
    if (!byDate.has(iso)) byDate.set(iso, { active: [], off: [] });
    return byDate.get(iso);
  };
  let min = null;
  let max = null;
  for (const c of classes) {
    for (const iso of c.dates) {
      ensure(iso).active.push(c);
      if (!min || iso < min) min = iso;
      if (!max || iso > max) max = iso;
    }
    for (const iso of c.offDates) ensure(iso).off.push(c);
  }
  if (!min) return `<p class="empty">표시할 일정이 없습니다.</p>`;

  // min~max 사이 월 목록
  const months = [];
  let y = parseInt(min.slice(0, 4), 10);
  let mo = parseInt(min.slice(5, 7), 10) - 1;
  const endY = parseInt(max.slice(0, 4), 10);
  const endMo = parseInt(max.slice(5, 7), 10) - 1;
  while (y < endY || (y === endY && mo <= endMo)) {
    months.push({ y, mo });
    mo += 1;
    if (mo > 11) {
      mo = 0;
      y += 1;
    }
  }
  let startIdx = months.findIndex((x) => x.y === current.y && x.mo === current.mo);
  if (startIdx < 0) startIdx = months.length - 1;

  let html = `<div class="monthnav"><button id="mprev" class="navbtn">이전</button><strong id="mlabel"></strong><button id="mnext" class="navbtn">다음</button></div>`;
  html += `<div class="monthscroll"><div class="monthinner">`;
  html += `<div class="monthwd">${MONTH_DOW.map((d) => `<span>${d}</span>`).join("")}</div>`;
  html += `<div id="months" data-start="${startIdx}">`;
  months.forEach((mm, idx) => {
    const cells = buildMonthGrid(mm.y, mm.mo);
    const label = `${mm.y}.${String(mm.mo + 1).padStart(2, "0")}`;
    let grid = "";
    for (const iso of cells) {
      if (!iso) {
        grid += `<div class="cell empty-cell"></div>`;
        continue;
      }
      const entry = byDate.get(iso);
      const day = parseInt(iso.slice(8, 10), 10);
      let chips = "";
      if (entry) {
        for (const c of entry.active) {
          const no = c.lessonByDate[iso];
          chips += `<span class="mchip${isAM(c.startTime) ? " am" : ""}" data-inst='${attr(splitInstructors(c.instructor).join("|"))}' title="${attr(`${c.startTime} ${no ? `${no}강 ` : ""}${c.name} · ${c.instructor}`)}">${esc(c.startTime)} ${no ? `${no}강 ` : ""}${esc(c.instructor || c.name)}</span>`;
        }
        for (const c of entry.off) chips += `<span class="mchip off" data-inst='${attr(splitInstructors(c.instructor).join("|"))}' title="${attr(`${c.name} 휴강`)}">휴강 ${esc(c.instructor || c.name)}</span>`;
      }
      grid += `<div class="cell"><span class="cday">${day}</span><div class="citems">${chips}</div></div>`;
    }
    html += `<div class="month" data-month="${idx}" data-label="${label}" style="display:${idx === startIdx ? "grid" : "none"}">${grid}</div>`;
  });
  html += `</div></div></div>`;
  return html;
}

function renderSchedule(classes, current, todayIso, showFilter = true) {
  const total = classes.length;
  let html = `<p class="meta">주간 클래스 ${total}건</p>`;
  if (showFilter) html += instructorFilterBar(summarizeInstructors(classes), total);
  html += `<div class="subtabs"><button class="subtab active" data-sub="week">주간</button><button class="subtab" data-sub="month">월간</button></div>`;
  html += `<div class="subview" data-subview="week">${renderWeekly(classes, todayIso)}</div>`;
  html += `<div class="subview" data-subview="month" style="display:none">${renderMonthly(classes, current)}</div>`;
  return html;
}

function renderCompleted(rows, showFilter = true) {
  let html = `<p class="meta">종강 ${rows.length}건 (DONE 그룹)</p>`;
  if (showFilter) html += instructorFilterBar(summarizeInstructors(rows), rows.length);
  html += table(
    ["종강일", "클래스", "강사", "길이/시간", "수강 기간", "수강생"],
    rows.map((c) => ({
      inst: splitInstructors(c.instructor).join("|"),
      cells: [`<strong>${esc(c.endDate || "-")}</strong>`, esc(c.name), `<span class="tag inst">${esc(c.instructor || "미배정")}</span>`, `${esc(c.length || "-")}${c.startTime ? ` · ${esc(c.startTime)}` : ""}`, `${esc(c.startDate)} ~ ${esc(c.endDate)}`, esc(c.students || "-")],
    })),
  );
  return html;
}

const STYLE = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,"Malgun Gothic",sans-serif;background:#f1f5f9;color:#0f172a}
header{background:#0f172a;color:#fff;padding:18px 24px}header h1{margin:0;font-size:18px}header p{margin:4px 0 0;font-size:12px;color:#94a3b8}
nav{display:flex;gap:6px;padding:12px 24px;background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:5;flex-wrap:wrap}
nav button{border:1px solid #e2e8f0;background:#f8fafc;border-radius:999px;padding:8px 16px;font-size:14px;cursor:pointer}
nav button.active{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
main{padding:20px 24px;max-width:1400px;margin:0 auto}
.view{display:none}.view.active{display:block}.hidden{display:none!important}
.meta{color:#475569;font-size:13px;margin:0 0 12px}
.grp{font-size:14px;background:#eef2ff;padding:8px 12px;border-radius:8px;margin:18px 0 8px}.grp span{color:#64748b;font-weight:400}
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:8px;border-radius:10px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eef2f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
th{background:#f8fafc;color:#64748b;font-size:12px}td.empty,.empty{color:#94a3b8;text-align:center;padding:14px}
.badge{padding:2px 10px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:12px;font-weight:600}.badge.on{background:#d1fae5;color:#047857}
.filter{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}.flabel{font-size:12px;color:#64748b;font-weight:700;margin-right:4px}
.chip{border:1px solid #e2e8f0;background:#f8fafc;border-radius:999px;padding:4px 12px;font-size:13px;cursor:pointer}.chip.active{background:#1d4ed8;color:#fff;border-color:#1d4ed8}.chip b{color:#2563eb}.chip.active b{color:#fff}
.subtabs{display:flex;gap:6px;margin-bottom:12px}.subtab{border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:6px 14px;cursor:pointer}.subtab.active{background:#0f172a;color:#fff}
.week{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
.daycol{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
.dayhead{background:#f5f8ff;padding:8px 10px;font-weight:700;display:flex;justify-content:space-between}.dayhead span{color:#64748b;font-weight:400}
.dayhead.today{background:#1d4ed8;color:#fff}.dayhead.today span{color:#dbeafe}
.card{border:1px solid #eef2f6;border-radius:10px;margin:8px;padding:8px}
.ctime{display:flex;justify-content:space-between}.ctime strong{color:#1d4ed8}.ctime span{color:#64748b;font-size:11px}.card.am .ctime strong{color:#ea580c}
.cname{font-size:13px;font-weight:600;margin:4px 0}
.ctags{display:flex;flex-wrap:wrap;gap:4px}.tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#f1f5f9;color:#475569}.tag.inst{background:#dbeafe;color:#1e40af;font-weight:600}.tag.lesson{background:#fef9c3;color:#a16207;font-weight:700}
.card.off{background:#fafafa;opacity:.75}.card.off .cname{color:#b91c1c}
.cstu{font-size:12px;color:#334155;margin-top:4px}.cper{font-size:11px;color:#94a3b8;margin-top:4px}.offt{color:#b91c1c}
.monthnav{display:flex;justify-content:center;align-items:center;gap:14px;margin-bottom:10px}.navbtn{border:1px solid #e2e8f0;background:#f8fafc;border-radius:8px;padding:4px 12px;cursor:pointer}
.monthscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}.monthinner{min-width:640px}
.monthwd{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px}.monthwd span{text-align:center;font-size:12px;color:#64748b;font-weight:600}
.month{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.cell{min-height:92px;border:1px solid #e2e8f0;border-radius:10px;padding:6px;background:#fff;display:flex;flex-direction:column;gap:3px;overflow:hidden}.cell.empty-cell{background:transparent;border-color:transparent}
.cday{font-size:12px;font-weight:600;color:#475569}.citems{display:flex;flex-direction:column;gap:3px;overflow:hidden}
.mchip{font-size:10px;padding:1px 5px;border-radius:6px;background:#e0e7ff;color:#3730a3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mchip.am{background:#ffedd5;color:#9a3412}.mchip.off{background:#fee2e2;color:#b91c1c}
.gate{display:flex;justify-content:center;padding:80px 20px}
.gatebox{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;width:320px;text-align:center;box-shadow:0 10px 30px rgba(15,23,42,.06)}
.gatebox h2{margin:0 0 6px;font-size:18px}.gatebox p{margin:0 0 14px;font-size:13px;color:#64748b}
.gateinput{width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px;margin-bottom:10px;background:#fff}
.gatebox input{text-align:center}
.gatebox button{width:100%;padding:12px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-size:15px;cursor:pointer}
.pwerr{color:#b91c1c;font-size:12px;min-height:16px;margin:10px 0 0}
@media(max-width:900px){.week{grid-template-columns:repeat(2,1fr)}}
@media(max-width:640px){
  header{padding:14px 16px}nav{padding:10px 12px;gap:5px}nav button{padding:7px 12px;font-size:13px}
  main{padding:14px 12px}
  .week{grid-template-columns:1fr}
  th,td{max-width:none}
  .gate{padding:48px 16px}.gatebox{width:100%;max-width:340px;padding:22px}
}
`;

const SCRIPT = `
function initViews(){
  document.querySelectorAll('nav button').forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('nav button').forEach(function(x){x.classList.remove('active')});
    document.querySelectorAll('.view').forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');document.getElementById(b.dataset.tab).classList.add('active');});});
  document.querySelectorAll('.view').forEach(function(view){
    view.querySelectorAll('[data-filter-inst]').forEach(function(btn){btn.addEventListener('click',function(){
      var inst=btn.getAttribute('data-filter-inst');
      view.querySelectorAll('[data-filter-inst]').forEach(function(b){b.classList.remove('active')});
      btn.classList.add('active');
      view.querySelectorAll('[data-inst]').forEach(function(el){
        var list=(el.getAttribute('data-inst')||'').split('|');
        el.classList.toggle('hidden', inst!=='' && list.indexOf(inst)<0);});});});});
  document.querySelectorAll('.subtab').forEach(function(b){b.addEventListener('click',function(){
    var wrap=b.closest('.view');
    wrap.querySelectorAll('.subtab').forEach(function(x){x.classList.remove('active')});
    b.classList.add('active');
    wrap.querySelectorAll('.subview').forEach(function(v){v.style.display=(v.getAttribute('data-subview')===b.dataset.sub)?'block':'none';});});});
  var wbox=document.getElementById('weeks');if(wbox){
    var wks=Array.prototype.slice.call(wbox.querySelectorAll('.wk'));
    var widx=parseInt(wbox.getAttribute('data-start'),10)||0;
    function wshow(){wks.forEach(function(w,i){w.style.display=(i===widx)?'block':'none';});
      var wl=document.getElementById('wlabel');if(wl)wl.textContent=wks[widx]?wks[widx].getAttribute('data-label'):'';}
    var wp=document.getElementById('wprev'),wn=document.getElementById('wnext');
    if(wp)wp.onclick=function(){if(widx>0){widx--;wshow();}};
    if(wn)wn.onclick=function(){if(widx<wks.length-1){widx++;wshow();}};
    wshow();}
  var box=document.getElementById('months');if(box){
    var months=Array.prototype.slice.call(box.querySelectorAll('.month'));
    var idx=parseInt(box.getAttribute('data-start'),10)||0;
    function show(){months.forEach(function(m,i){m.style.display=(i===idx)?'grid':'none';});
      var lbl=document.getElementById('mlabel');if(lbl)lbl.textContent=months[idx]?months[idx].getAttribute('data-label'):'';}
    var p=document.getElementById('mprev'),n=document.getElementById('mnext');
    if(p)p.onclick=function(){if(idx>0){idx--;show();}};
    if(n)n.onclick=function(){if(idx<months.length-1){idx++;show();}};
    show();}
}
`;

// 데이터를 비밀번호로 AES-256-GCM 암호화 (브라우저 WebCrypto 로 복호화).
function encryptContent(text, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    data: Buffer.concat([enc, tag]).toString("base64"), // ciphertext+tag (WebCrypto 규격)
  };
}

function renderApp(sections) {
  const tabs = sections.map((s, i) => `<button class="${i === 0 ? "active" : ""}" data-tab="${s.id}">${esc(s.label)}</button>`).join("");
  const views = sections.map((s, i) => `<section class="view ${i === 0 ? "active" : ""}" id="${s.id}"><h2 style="font-size:16px;margin:0 0 10px">${esc(s.label)}</h2>${s.html}</section>`).join("");
  return `<nav>${tabs}</nav><main>${views}</main>`;
}

function renderPage(sections, generatedAt, subtitle, storageKey) {
  const payload = encryptContent(renderApp(sections), VIEW_PASSWORD);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>어피니티 유니버스 스케줄 · ${esc(subtitle)}</title><style>${STYLE}</style></head><body>
<header><h1>어피니티 유니버스 스케줄</h1><p>${esc(subtitle)} · 갱신: ${esc(generatedAt)}</p></header>
<div id="gate" class="gate"><div class="gatebox"><h2>${esc(subtitle)}</h2><p>비밀번호를 입력하세요.</p>
<input id="pw" class="gateinput" type="password" inputmode="numeric" placeholder="비밀번호" autocomplete="off"><button id="pwbtn" type="button">확인</button><p id="pwerr" class="pwerr"></p></div></div>
<div id="app"></div>
<script>
var PAYLOAD=${JSON.stringify(payload)};
var SKEY=${JSON.stringify(`afv_pw_${storageKey}`)};
${SCRIPT}
function b64ToBytes(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0);});}
async function decryptContent(pw){
  var salt=b64ToBytes(PAYLOAD.salt),iv=b64ToBytes(PAYLOAD.iv),data=b64ToBytes(PAYLOAD.data);
  var km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
  var key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:100000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
  var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:iv},key,data);
  return new TextDecoder().decode(pt);
}
async function unlock(){
  var pw=document.getElementById('pw').value;
  try{
    var html=await decryptContent(pw);
    document.getElementById('app').innerHTML=html;
    document.getElementById('gate').style.display='none';
    initViews();
    try{sessionStorage.setItem(SKEY,pw);}catch(e){}
  }catch(e){document.getElementById('pwerr').textContent='비밀번호가 올바르지 않습니다.';}
}
document.getElementById('pwbtn').addEventListener('click',unlock);
document.getElementById('pw').addEventListener('keydown',function(e){if(e.key==='Enter')unlock();});
(function(){try{var s=sessionStorage.getItem(SKEY);if(s){document.getElementById('pw').value=s;unlock();}}catch(e){}})();
</script></body></html>`;
}

async function main() {
  const now = new Date();
  console.log("먼데이 보드 조회 중…");
  const [db, cls] = await Promise.all([
    fetchBoardItems(STUDENT_BOARD, ["date4", "color_mknkc0rw", "text_mknkvpaq", "link", "text_mktj6gkp", "text_mksvtgc8", "formula_mkv1sj2z"]),
    fetchBoardItems(CLASS_BOARD, ["color_mm07m65v", "hour", "lookup", "project_owner", "formula_mkzy2qad", "multiple_person_mkywhxez", "board_relation_mkss72aq", "board_relation_mm52z2sq"], ["date65"]),
  ]);

  const students = mapStudents(db.items);
  const weekdayClasses = mapWeekdayClasses(cls.items);
  const completed = mapCompleted(cls.items);
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now); // YYYY-MM-DD (KST)
  const current = { y: parseInt(todayIso.slice(0, 4), 10), mo: parseInt(todayIso.slice(5, 7), 10) - 1 };
  // 강사 목록 (스케줄 + 종강 강사 합집합, 개별 이름)
  const instructors = summarizeInstructors([...weekdayClasses, ...completed]).map((i) => i.name);

  const generatedAt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "long", timeStyle: "short" }).format(now);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "", "utf8");

  // ── 관리자(루트): 전체 ──
  const adminHtml = renderPage(
    [
      { id: "schedule", label: "강사 스케줄", html: renderSchedule(weekdayClasses, current, todayIso, true) },
      { id: "completed", label: "종강 리스트", html: renderCompleted(completed, true) },
      { id: "students", label: "수강생 DB", html: renderStudents(students) },
    ],
    generatedAt,
    "관리자 (전체)",
    "admin",
  );
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), adminHtml, "utf8");

  // ── 강사별 페이지: /강사명/ (본인 클래스만) ──
  const hasInstructor = (c, name) => splitInstructors(c.instructor).indexOf(name) >= 0;
  const links = [];
  for (const name of instructors) {
    if (name === "미배정") continue;
    const myWeek = weekdayClasses.filter((c) => hasInstructor(c, name));
    const myDone = completed.filter((c) => hasInstructor(c, name));
    const page = renderPage(
      [
        { id: "schedule", label: "강사 스케줄", html: renderSchedule(myWeek, current, todayIso, false) },
        { id: "completed", label: "종강 리스트", html: renderCompleted(myDone, false) },
      ],
      generatedAt,
      `${name} 강사`,
      name,
    );
    const dir = path.join(OUT_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), page, "utf8");
    links.push(`/${encodeURI(name)}/  (주간 ${myWeek.length} · 종강 ${myDone.length})`);
  }

  const totalStudents = students.reduce((s, g) => s + g.rows.length, 0);
  console.log(`완료: 수강생 ${totalStudents} · 주간클래스 ${weekdayClasses.length} · 종강 ${completed.length} · 강사페이지 ${links.length}`);
  console.log(`관리자: /  (전체)`);
  links.forEach((l) => console.log("강사:", l));
}

main().catch((err) => {
  console.error("생성 실패:", err.message);
  process.exit(1);
});
