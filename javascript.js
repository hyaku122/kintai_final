/* =========================
   勤怠PWA (Front-end only)
   - Data: localStorage
   - TZ: Asia/Tokyo (表示/日付計算はJST基準で扱う)
   ========================= */

(() => {
  "use strict";

  /* ==== 採用した前提（要件未記載の細部） ====
   1) 判定欄の「初期状態は空欄」→ データが無い日/打刻していない日は空欄。
      出勤/退勤を入力（ボタン押下 or time入力変更）した時点で判定を表示。
      その後、時刻をクリアした場合は「空欄」に戻す。
   2) 休日出勤日の判定表示なし→ 休日出勤の区分が選ばれている日は判定欄を常に空にする。
   3) 祝日判定は 2000年以降を中心に実装（固定日/ハッピーマンデー/春分秋分/振替/国民の休日/主要特例）。
      （一般的な勤怠用途で十分な精度を狙う）
   4) 月次集計の「予定稼働日数」→ 土日祝 + 会社休日 + 有給(区分) は除外せず「平日通常日」を予定とする。
      つまり、有給にしても予定稼働日数は “平日ならカウント” される（勤怠上は予定勤務日だった、という解釈）。
      ※もし「有給は予定から除外したい」場合は要件変更になるので今は採用しない。
  ====================================== */

  const TZ = "Asia/Tokyo";
  const LOCALE = "ja-JP";

  const WAGE_YEN = 1500;
  const BREAK_MIN = 60;
  const STD_START = "09:30";
  const STD_END = "18:30";
  const STD_WORK_MIN = 8 * 60; // 実働8hの閾値

  const STORAGE_KEY = "attendancePWA:v1";
  const STORAGE_COMPANY_HOLIDAYS = "attendancePWA:companyHolidays:v1";

  /** @type {Record<string, DayRecord>} */
  let db = loadDb();

  /** @type {Set<string>} YYYY-MM-DD */
  let companyHolidays = loadCompanyHolidays();

  const now = getNowJst();
  let selectedYear = now.year;
  let selectedMonth = now.month; // 1-12

  // UI refs
  const monthTabsEl = document.getElementById("monthTabs");
  const rowsEl = document.getElementById("rows");
  const summaryWrapEl = document.getElementById("summaryWrap");

  const settingsDialog = document.getElementById("settingsDialog");
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  const companyHolidayDate = document.getElementById("companyHolidayDate");
  const addCompanyHolidayBtn = document.getElementById("addCompanyHolidayBtn");
  const companyHolidayList = document.getElementById("companyHolidayList");
  const resetAllBtn = document.getElementById("resetAllBtn");
  const wageLabel = document.getElementById("wageLabel");

  wageLabel.textContent = String(WAGE_YEN);

  // Register service worker
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      } catch (e) {
        console.warn("SW register failed", e);
      }
    });
  }

  /* ========== Types ========== */
  /**
   * @typedef {"normal" | "paid" | "holidayWork"} WorkKind
   *
   * @typedef {Object} DayRecord
   * @property {WorkKind} kind
   * @property {string|null} start  // "HH:MM"
   * @property {string|null} end    // "HH:MM"
   * @property {string} note
   * @property {boolean} judged     // 判定表示を行うトリガ（初期はfalse）
   */

  /* ========== Init ========== */
  function init() {
    buildMonthTabs();
    bindSettings();
    renderAll();
  }

  function buildMonthTabs() {
    monthTabsEl.innerHTML = "";
    for (let m = 1; m <= 12; m++) {
      const btn = document.createElement("button");
      btn.className = "monthTab";
      btn.type = "button";
      btn.role = "tab";
      btn.dataset.month = String(m);
      btn.textContent = `${m}月`;
      btn.setAttribute("aria-selected", m === selectedMonth ? "true" : "false");
      btn.addEventListener("click", () => {
        selectedMonth = m;
        updateMonthTabSelected();
        renderAll();
        // 要件：選択中タブが左端に来るよう自動スクロール
        scrollTabToLeft(btn);
      });
      monthTabsEl.appendChild(btn);
    }

    // 初期も左寄せする
    const initialBtn = monthTabsEl.querySelector(`.monthTab[data-month="${selectedMonth}"]`);
    if (initialBtn) scrollTabToLeft(initialBtn);
  }

  function updateMonthTabSelected() {
    monthTabsEl.querySelectorAll(".monthTab").forEach((b) => {
      b.setAttribute("aria-selected", b.dataset.month === String(selectedMonth) ? "true" : "false");
    });
  }

  function scrollTabToLeft(tabBtn) {
    const container = monthTabsEl;
    const left = tabBtn.offsetLeft;
    container.scrollTo({ left, behavior: "smooth" });
  }

  function bindSettings() {
    openSettingsBtn.addEventListener("click", () => {
      renderCompanyHolidayList();
      // date input default: today
      const t = getNowJst();
      companyHolidayDate.value = `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
      settingsDialog.showModal();
    });

    addCompanyHolidayBtn.addEventListener("click", () => {
      const v = companyHolidayDate.value;
      if (!v) return;
      const key = normalizeDateKey(v);
      companyHolidays.add(key);
      saveCompanyHolidays(companyHolidays);
      renderCompanyHolidayList();
      renderAll();
    });

    resetAllBtn.addEventListener("click", () => {
      const ok = confirm("全データを削除します。よろしいですか？（取り消し不可）");
      if (!ok) return;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_COMPANY_HOLIDAYS);
      db = {};
      companyHolidays = new Set();
      renderCompanyHolidayList();
      renderAll();
      alert("削除しました。");
    });
  }

  function renderCompanyHolidayList() {
    companyHolidayList.innerHTML = "";
    const list = Array.from(companyHolidays).sort();
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "会社休日は未登録です。";
      companyHolidayList.appendChild(empty);
      return;
    }
    for (const d of list) {
      const item = document.createElement("div");
      item.className = "holidayItem";
      item.setAttribute("role", "listitem");

      const left = document.createElement("div");
      left.className = "date";
      left.textContent = d;

      const rm = document.createElement("button");
      rm.className = "remove";
      rm.type = "button";
      rm.textContent = "削除";
      rm.addEventListener("click", () => {
        companyHolidays.delete(d);
        saveCompanyHolidays(companyHolidays);
        renderCompanyHolidayList();
        renderAll();
      });

      item.appendChild(left);
      item.appendChild(rm);
      companyHolidayList.appendChild(item);
    }
  }

  /* ========== Rendering ========== */
  function renderAll() {
    renderSummary();
    renderRows();
  }

  function renderSummary() {
    const { year, month } = { year: selectedYear, month: selectedMonth };
    const days = getDaysInMonth(year, month);

    let plannedWorkingDays = 0;
    let actualWorkingDays = 0;

    let totalWorkMin = 0;
    let regularMin = 0;
    let overtimeMin = 0;

    let regularPay = 0;
    let overtimePay = 0;

    for (let day = 1; day <= days; day++) {
      const dateKey = ymdKey(year, month, day);
      const meta = getDayMeta(year, month, day);

      const rec = getOrDefaultRecord(dateKey);

      // 予定稼働日数: 土日祝・会社休日を除く（平日通常扱いの日）
      if (!meta.isWeekend && !meta.isHoliday && !meta.isCompanyHoliday) {
        plannedWorkingDays += 1;
      }

      // 実働日数: 出勤記録がある日 + 有給日
      const hasClock = !!rec.start && !!rec.end;
      if (rec.kind === "paid") {
        actualWorkingDays += 1;
      } else if (hasClock) {
        actualWorkingDays += 1;
      }

      // 勤務時間/給与
      const calc = calculateDay(rec, meta);
      totalWorkMin += calc.workMin;
      regularMin += calc.regularMin;
      overtimeMin += calc.overtimeMin;

      regularPay += calc.regularPay;
      overtimePay += calc.overtimePay;
    }

    // rounding: 円単位四捨五入
    regularPay = Math.round(regularPay);
    overtimePay = Math.round(overtimePay);
    const totalPay = Math.round(regularPay + overtimePay);

    const totalWorkH = minToHourStr(totalWorkMin);
    const regularH = minToHourStr(regularMin);
    const overtimeH = minToHourStr(overtimeMin);

    summaryWrapEl.innerHTML = `
      <div class="summaryCard">
        <div class="summaryGrid">
          <div class="summaryItem">
            <div class="summaryLabel">実働日数 / 予定稼働日数</div>
            <div class="summaryValue"><span class="mono">${actualWorkingDays}</span>/<span class="mono">${plannedWorkingDays}</span></div>
          </div>
          <div class="summaryItem">
            <div class="summaryLabel">総勤務時間</div>
            <div class="summaryValue mono">${totalWorkH}</div>
          </div>
          <div class="summaryItem">
            <div class="summaryLabel">定時勤務時間</div>
            <div class="summaryValue mono">${regularH}</div>
          </div>
          <div class="summaryItem">
            <div class="summaryLabel">残業時間</div>
            <div class="summaryValue mono">${overtimeH}</div>
          </div>
          <div class="summaryItem">
            <div class="summaryLabel">定時給料</div>
            <div class="summaryValue mono">${yen(regularPay)}</div>
          </div>
          <div class="summaryItem">
            <div class="summaryLabel">残業代</div>
            <div class="summaryValue mono">${yen(overtimePay)}</div>
          </div>
          <div class="summaryItem" style="grid-column: 1 / -1;">
            <div class="summaryLabel">総支給額</div>
            <div class="summaryValue mono">${yen(totalPay)}</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderRows() {
    rowsEl.innerHTML = "";
    const year = selectedYear;
    const month = selectedMonth;
    const days = getDaysInMonth(year, month);

    for (let day = 1; day <= days; day++) {
      const dateKey = ymdKey(year, month, day);
      const meta = getDayMeta(year, month, day);
      const rec = getOrDefaultRecord(dateKey);

      const row = document.createElement("section");
      row.className = "row";
      if (meta.weekday === 6) row.classList.add("isSaturday");
      if (meta.isHoliday || meta.weekday === 0 || meta.isCompanyHoliday) row.classList.add("isHoliday");

      // date line: 日付と曜日は「間に半角スペース1つのみ」
      const dateLine = `${month}/${day} ${meta.weekdayJa}`;

      // 勤怠区分アイコン（sparkles.circle風）
      const kindBtn = document.createElement("button");
      kindBtn.type = "button";
      kindBtn.className = "kindBtn";
      kindBtn.title = "勤怠区分（有給/休日出勤/通常）";
      kindBtn.setAttribute("aria-label", "勤怠区分");
      applyKindBtnColor(kindBtn, rec.kind);

      kindBtn.innerHTML = sparklesCircleSvg();

      kindBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openKindMenu(kindBtn, dateKey);
      });

      const dateCell = document.createElement("div");
      dateCell.className = "dateCell";
      dateCell.innerHTML = `
        <div class="dateLine">${escapeHtml(dateLine)}</div>
        <div class="subLine">
          <span class="dayBadge">${meta.badgeText}</span>
        </div>
      `;
      // sublineにアイコンを差し込む
      dateCell.querySelector(".subLine").prepend(kindBtn);

      // 出勤/退勤 UI条件
      const isWeekendOrHoliday = meta.isHoliday || meta.weekday === 0 || meta.weekday === 6 || meta.isCompanyHoliday;
      const canInputTimes =
        (!isWeekendOrHoliday && rec.kind === "normal") ||
        (isWeekendOrHoliday && rec.kind === "holidayWork") ||
        (!isWeekendOrHoliday && rec.kind === "holidayWork"); // 平日でも「休日出勤」にした場合は手入力可扱い

      const hideClockButtons = isWeekendOrHoliday && rec.kind !== "holidayWork";
      const isPaid = rec.kind === "paid";

      // 出勤セル
      const startCell = document.createElement("div");
      startCell.className = "timeCell";

      // 退勤セル
      const endCell = document.createElement("div");
      endCell.className = "timeCell";

      if (isPaid) {
        startCell.innerHTML = `<div class="timeHint">（有給）</div>`;
        endCell.innerHTML = `<div class="timeHint">（有給）</div>`;
      } else if (!canInputTimes) {
        startCell.innerHTML = `<div class="timeHint">（休日）</div>`;
        endCell.innerHTML = `<div class="timeHint">（休日）</div>`;
      } else {
        // 出勤
        const startRow = document.createElement("div");
        startRow.className = "timeRow";
        if (!hideClockButtons && !isWeekendOrHoliday && rec.kind === "normal") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "smallButton";
          btn.textContent = "出勤";
          btn.addEventListener("click", () => {
            upsertRecord(dateKey, (r) => {
              r.start = STD_START;
              r.judged = true; // 判定反映
            });
            renderAll();
          });
          startRow.appendChild(btn);
        }

        const startInput = document.createElement("input");
        startInput.type = "time";
        startInput.step = "60"; // 1分単位
        startInput.className = "timeInput";
        startInput.value = rec.start ?? "";
        startInput.addEventListener("change", () => {
          upsertRecord(dateKey, (r) => {
            r.start = startInput.value || null;
            r.judged = !!(r.start || r.end); // 入力があれば判定対象
          });
          renderAll();
        });

        startRow.appendChild(startInput);
        startCell.appendChild(startRow);

        // 退勤
        const endRow = document.createElement("div");
        endRow.className = "timeRow";
        if (!hideClockButtons && !isWeekendOrHoliday && rec.kind === "normal") {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "smallButton";
          btn.textContent = "退勤";
          btn.addEventListener("click", () => {
            upsertRecord(dateKey, (r) => {
              r.end = STD_END;
              r.judged = true;
            });
            renderAll();
          });
          endRow.appendChild(btn);
        }

        const endInput = document.createElement("input");
        endInput.type = "time";
        endInput.step = "60";
        endInput.className = "timeInput";
        endInput.value = rec.end ?? "";
        endInput.addEventListener("change", () => {
          upsertRecord(dateKey, (r) => {
            r.end = endInput.value || null;
            r.judged = !!(r.start || r.end);
          });
          renderAll();
        });

        endRow.appendChild(endInput);
        endCell.appendChild(endRow);

        // hint
        const hint = document.createElement("div");
        hint.className = "timeHint";
        hint.textContent = isWeekendOrHoliday ? "休日出勤は手入力" : "時刻は編集可";
        startCell.appendChild(hint.cloneNode(true));
        endCell.appendChild(hint);
      }

      // 判定
      const judgeCell = document.createElement("div");
      judgeCell.className = "judgeCell";

      const judge = getJudgeText(rec, meta);
      if (judge) {
        const span = document.createElement("span");
        span.className = "judgeLabel";
        const isRed = /遅刻|早退|残業/.test(judge);
        span.classList.add(isRed ? "isRed" : "isBlue");
        span.textContent = judge;
        judgeCell.appendChild(span);
      } else {
        // 初期状態は空欄（空のまま）
      }

      // 実働
      const workCell = document.createElement("div");
      workCell.className = "workCell mono";
      const calc = calculateDay(rec, meta);
      workCell.textContent = calc.workMin > 0 ? minToHourStr(calc.workMin) : "";

      // 備考
      const noteArea = document.createElement("textarea");
      noteArea.className = "noteInput";
      noteArea.placeholder = "備考";
      noteArea.value = rec.note || "";
      noteArea.addEventListener("change", () => {
        upsertRecord(dateKey, (r) => {
          r.note = noteArea.value;
        });
        // 備考だけなら全再描画は不要だけど単純に
        renderAll();
      });

      const noteCell = document.createElement("div");
      noteCell.appendChild(noteArea);

      // compose row
      const rowTop = document.createElement("div");
      rowTop.className = "rowTop";

      rowTop.appendChild(dateCell);
      rowTop.appendChild(startCell);
      rowTop.appendChild(endCell);
      rowTop.appendChild(judgeCell);
      rowTop.appendChild(workCell);
      rowTop.appendChild(noteCell);

      row.appendChild(rowTop);
      rowsEl.appendChild(row);
    }
  }

  /* ========== 勤怠区分メニュー ========== */
  function openKindMenu(anchorBtn, dateKey) {
    // 超ミニな “自前メニュー” (dialogではなく、confirm風に)
    // iPhone Safariでも確実に動くよう prompt/confirm を使わず、簡易popoverをDOMで作る
    closeAnyMenu();

    const menu = document.createElement("div");
    menu.className = "kindMenu";
    menu.style.position = "fixed";
    menu.style.zIndex = "2000";
    menu.style.minWidth = "180px";
    menu.style.background = "white";
    menu.style.border = "1px solid rgba(0,0,0,0.12)";
    menu.style.borderRadius = "14px";
    menu.style.boxShadow = "0 18px 40px rgba(0,0,0,0.18)";
    menu.style.padding = "8px";
    menu.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Noto Sans JP, sans-serif";

    const rect = anchorBtn.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 170, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 200, rect.left);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    const items = [
      { label: "有給", kind: "paid" },
      { label: "休日出勤", kind: "holidayWork" },
      { label: "通常に戻す", kind: "normal" },
    ];

    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = it.label;
      b.style.width = "100%";
      b.style.textAlign = "left";
      b.style.padding = "10px 12px";
      b.style.border = "1px solid rgba(0,0,0,0.08)";
      b.style.borderRadius = "12px";
      b.style.background = "white";
      b.style.cursor = "pointer";
      b.style.fontWeight = "800";
      b.style.margin = "4px 0";
      b.addEventListener("click", () => {
        upsertRecord(dateKey, (r) => {
          r.kind = it.kind;
          // 区分切替時のフィールド整理
          if (r.kind === "paid") {
            r.start = null;
            r.end = null;
            r.judged = false; // 有給は判定なし
          } else if (r.kind === "normal") {
            // 休日に戻す場合は時刻は残して良い/悪いが要件無し → 誤打刻を避けてクリア
            // ※ただし平日の通常に戻す時に残したい人もいるので、
            //   「休日出勤→通常」の場合のみクリアしない、などは要件外。ここでは単純に保持。
            //   ただし休日(ボタン非表示)で残ってると見えづらいので、休日(=週末/祝日/会社休日)はクリア。
            //   （平日は保持）
            const meta = parseDateKeyMeta(dateKey);
            const dmeta = getDayMeta(meta.year, meta.month, meta.day);
            const isWeekendOrHoliday = dmeta.isHoliday || dmeta.weekday === 0 || dmeta.weekday === 6 || dmeta.isCompanyHoliday;
            if (isWeekendOrHoliday) {
              r.start = null;
              r.end = null;
              r.judged = false;
            }
          } else if (r.kind === "holidayWork") {
            // 判定表示なし固定
            r.judged = false;
          }
        });
        closeAnyMenu();
        renderAll();
      });
      menu.appendChild(b);
    }

    document.body.appendChild(menu);

    const blocker = document.createElement("div");
    blocker.className = "menuBlocker";
    blocker.style.position = "fixed";
    blocker.style.inset = "0";
    blocker.style.zIndex = "1999";
    blocker.addEventListener("click", closeAnyMenu);

    document.body.appendChild(blocker);
  }

  function closeAnyMenu() {
    document.querySelectorAll(".kindMenu, .menuBlocker").forEach((el) => el.remove());
  }

  /* ========== Logic: Judge / Calc ========== */
  function getJudgeText(rec, meta) {
    // 休日出勤日は判定表示なし
    if (rec.kind === "holidayWork") return "";

    // 初期状態は空欄 → judgedがtrueで、かつ時刻が入った時だけ表示
    if (!rec.judged) return "";

    // 有給は判定なし
    if (rec.kind === "paid") return "";

    // start/endどちらも無ければ空欄
    if (!rec.start && !rec.end) return "";

    const parts = [];

    if (rec.start) {
      const late = compareTime(rec.start, STD_START) > 0;
      const early = compareTime(rec.start, STD_START) < 0;
      if (late) parts.push("遅刻");
      if (early) parts.push("早出");
    }

    if (rec.end) {
      const earlyLeave = compareTime(rec.end, STD_END) < 0;
      const overtime = compareTime(rec.end, STD_END) > 0;
      if (earlyLeave) parts.push("早退");
      if (overtime) parts.push("残業");
    }

    // 他判定がない場合のみ「定時」
    if (parts.length === 0 && rec.start && rec.end) return "定時";

    // 区切り「・」
    return parts.join("・");
  }

  function calculateDay(rec, meta) {
    // returns minutes + pay components
    // pay rules:
    // - normal weekday: regular = min(work,8h) * wage, overtime = max(work-8h,0) * wage*1.25
    // - holidayWork: all work * wage*1.25 (as overtimePay)
    // - paid: fixed 8h regular, no overtime
    let workMin = 0;

    if (rec.kind === "paid") {
      workMin = 8 * 60;
      const regularPay = (workMin / 60) * WAGE_YEN;
      return {
        workMin,
        regularMin: workMin,
        overtimeMin: 0,
        regularPay,
        overtimePay: 0,
      };
    }

    if (rec.start && rec.end) {
      const diff = timeToMin(rec.end) - timeToMin(rec.start);
      workMin = Math.max(0, diff - BREAK_MIN);
    } else {
      workMin = 0;
    }

    if (rec.kind === "holidayWork") {
      const pay = (workMin / 60) * WAGE_YEN * 1.25;
      return {
        workMin,
        regularMin: 0,
        overtimeMin: workMin,
        regularPay: 0,
        overtimePay: pay,
      };
    }

    // normal
    const regularMin = Math.min(workMin, STD_WORK_MIN);
    const overtimeMin = Math.max(0, workMin - STD_WORK_MIN);

    const regularPay = (regularMin / 60) * WAGE_YEN;
    const overtimePay = (overtimeMin / 60) * WAGE_YEN * 1.25;

    return { workMin, regularMin, overtimeMin, regularPay, overtimePay };
  }

  /* ========== Holiday calculation (Japan) ========== */
  function getDayMeta(year, month, day) {
    const weekday = weekdayJst(year, month, day); // 0 Sun ... 6 Sat
    const weekdayJa = ["日", "月", "火", "水", "木", "金", "土"][weekday];

    const key = ymdKey(year, month, day);
    const isCompanyHoliday = companyHolidays.has(key);

    const holidayName = getJapanHolidayName(year, month, day);
    const isHoliday = !!holidayName;

    const isWeekend = weekday === 0 || weekday === 6;

    // badge text
    let badgeText = "";
    if (isCompanyHoliday) badgeText = "会社休日";
    else if (holidayName) badgeText = holidayName;
    else if (weekday === 0) badgeText = "日";
    else if (weekday === 6) badgeText = "土";
    else badgeText = "平日";

    return { weekday, weekdayJa, isHoliday, holidayName, isCompanyHoliday, isWeekend, badgeText };
  }

  function getJapanHolidayName(year, month, day) {
    // Base holidays (name) then apply substitute & citizen's holiday.
    // We compute for the specific date by:
    // 1) Determine "primary holiday" for that date.
    // 2) If none: check substitute holiday.
    // 3) If none: check citizen's holiday.
    const primary = getPrimaryHolidayName(year, month, day);
    if (primary) return primary;

    // Substitute holiday (振替休日): if a holiday falls on Sunday, next weekday becomes holiday (since 1973-04-12)
    const sub = getSubstituteHolidayName(year, month, day);
    if (sub) return sub;

    // Citizen's holiday (国民の休日): a day between two holidays becomes holiday (since 1985-12-27)
    const citizen = getCitizensHolidayName(year, month, day);
    if (citizen) return citizen;

    return "";
  }

  function getPrimaryHolidayName(year, month, day) {
    // Fixed date holidays and Happy Monday etc.
    // Special cases: Emperor's Birthday changes, etc.
    // NOTE: We include common rules; some historical transitions included.

    // 1/1 元日
    if (month === 1 && day === 1) return "元日";

    // 成人の日: 1/15 (until 1999), 2nd Monday of Jan (2000-)
    if (month === 1) {
      if (year <= 1999 && day === 15) return "成人の日";
      if (year >= 2000 && day === nthWeekdayOfMonth(year, 1, 1, 2)) return "成人の日"; // Monday=1, 2nd
    }

    // 建国記念の日 2/11 (1967-)
    if (month === 2 && day === 11 && year >= 1967) return "建国記念の日";

    // 天皇誕生日:
    // - 2019- : 2/23 (Reiwa)
    // - 1989-2018 : 12/23
    // - 1927-1988 : 4/29 (as 天皇誕生日 then later みどり/昭和)
    if (year >= 2020 && month === 2 && day === 23) return "天皇誕生日";
    if (year >= 1989 && year <= 2018 && month === 12 && day === 23) return "天皇誕生日";
    if (year >= 1927 && year <= 1988 && month === 4 && day === 29) return "天皇誕生日";

    // 春分の日 (approx)
    if (month === 3 && day === vernalEquinoxDay(year)) return "春分の日";

    // 昭和の日 / みどりの日 / 天皇誕生日(旧) 4/29
    if (month === 4 && day === 29) {
      if (year >= 2007) return "昭和の日";
      if (year >= 1989 && year <= 2006) return "みどりの日";
      if (year <= 1988) return "天皇誕生日";
    }

    // 憲法記念日 5/3
    if (month === 5 && day === 3) return "憲法記念日";
    // みどりの日 5/4 (since 2007, before it was "国民の休日"扱い)
    if (month === 5 && day === 4 && year >= 2007) return "みどりの日";
    // こどもの日 5/5
    if (month === 5 && day === 5) return "こどもの日";

    // 海の日: 7/20 (1996-2002), 3rd Monday Jul (2003-)
    if (month === 7) {
      if (year >= 1996 && year <= 2002 && day === 20) return "海の日";
      if (year >= 2003 && day === nthWeekdayOfMonth(year, 7, 1, 3)) return "海の日";
      // Olympic special cases (2020/2021) but not needed for 2026; still included
      if (year === 2020 && day === 23) return "海の日";
      if (year === 2021 && day === 22) return "海の日";
    }

    // 山の日: 8/11 (2016-), special 2020/2021
    if (month === 8) {
      if (year >= 2016 && year !== 2020 && year !== 2021 && day === 11) return "山の日";
      if (year === 2020 && day === 10) return "山の日";
      if (year === 2021 && day === 8) return "山の日";
    }

    // 敬老の日: 9/15 (1966-2002), 3rd Monday Sep (2003-)
    if (month === 9) {
      if (year >= 1966 && year <= 2002 && day === 15) return "敬老の日";
      if (year >= 2003 && day === nthWeekdayOfMonth(year, 9, 1, 3)) return "敬老の日";
    }

    // 秋分の日 (approx)
    if (month === 9 && day === autumnalEquinoxDay(year)) return "秋分の日";

    // スポーツの日（体育の日）:
    // - 体育の日: 10/10 (1966-1999), 2nd Monday Oct (2000-2019)
    // - スポーツの日: 2nd Monday Oct (2020-) except 2020/2021 special
    if (month === 10) {
      if (year >= 1966 && year <= 1999 && day === 10) return "体育の日";
      if (year >= 2000 && year <= 2019 && day === nthWeekdayOfMonth(year, 10, 1, 2)) return "体育の日";
      if (year >= 2022 && day === nthWeekdayOfMonth(year, 10, 1, 2)) return "スポーツの日";
      if (year === 2020 && day === 24) return "スポーツの日";
      if (year === 2021 && day === 23) return "スポーツの日";
    }

    // 文化の日 11/3
    if (month === 11 && day === 3) return "文化の日";
    // 勤労感謝の日 11/23
    if (month === 11 && day === 23) return "勤労感謝の日";

    return "";
  }

  function getSubstituteHolidayName(year, month, day) {
    // law effective 1973-04-12
    const target = makeDateObj(year, month, day);
    if (target < makeDateObj(1973, 4, 12)) return "";

    // If today is Monday..Saturday and some previous day was a holiday that fell on Sunday,
    // then today becomes substitute holiday (first weekday after continuous holidays starting on Sunday).
    // We'll check backward until we hit a non-holiday; if any of those was Sunday holiday, substitute applies.
    const w = weekdayJst(year, month, day);
    if (w === 0) return ""; // Sunday itself is not substitute

    // if the day itself is a primary holiday, no substitute
    if (getPrimaryHolidayName(year, month, day)) return "";

    // Check previous days: if immediately previous day is holiday, and chain leads back to Sunday holiday.
    let back = 1;
    while (back <= 7) {
      const d = addDaysJst(year, month, day, -back);
      const pname = getPrimaryHolidayName(d.year, d.month, d.day) || getCitizensHolidayName(d.year, d.month, d.day);
      if (!pname) break;
      if (weekdayJst(d.year, d.month, d.day) === 0 && getPrimaryHolidayName(d.year, d.month, d.day)) {
        return "振替休日";
      }
      back += 1;
    }

    // Also: if yesterday is Sunday holiday (simple case)
    const y = addDaysJst(year, month, day, -1);
    if (weekdayJst(y.year, y.month, y.day) === 0 && getPrimaryHolidayName(y.year, y.month, y.day)) {
      return "振替休日";
    }

    return "";
  }

  function getCitizensHolidayName(year, month, day) {
    // Effective 1985-12-27 (practically 1986-)
    const target = makeDateObj(year, month, day);
    if (target < makeDateObj(1985, 12, 27)) return "";

    // If a weekday is between two primary holidays, it's a holiday.
    // Condition: day is not Sunday and not Saturday? law says weekday; but typically excludes Sunday.
    // We'll implement: if not primary holiday and weekday is Mon-Fri, and prev/next are primary holidays.
    if (getPrimaryHolidayName(year, month, day)) return "";

    const w = weekdayJst(year, month, day);
    if (w === 0) return ""; // Sunday

    const prev = addDaysJst(year, month, day, -1);
    const next = addDaysJst(year, month, day, +1);

    const prevIsPrimary = !!getPrimaryHolidayName(prev.year, prev.month, prev.day);
    const nextIsPrimary = !!getPrimaryHolidayName(next.year, next.month, next.day);

    if (prevIsPrimary && nextIsPrimary) return "国民の休日";
    return "";
  }

  // Vernal Equinox (春分): approximation valid for 1900-2099
  function vernalEquinoxDay(year) {
    if (year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4));
    if (year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
    return 20;
  }
  // Autumnal Equinox (秋分)
  function autumnalEquinoxDay(year) {
    if (year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1983) / 4));
    if (year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
    return 23;
  }

  // nth weekday day-of-month (weekday: 0 Sun..6 Sat). ex: 2nd Monday => weekday=1, nth=2
  function nthWeekdayOfMonth(year, month, weekday, nth) {
    const firstW = weekdayJst(year, month, 1);
    const delta = (7 + weekday - firstW) % 7;
    return 1 + delta + (nth - 1) * 7;
  }

  /* ========== Storage ========== */
  function loadDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || !parsed) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function saveDb() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function loadCompanyHolidays() {
    try {
      const raw = localStorage.getItem(STORAGE_COMPANY_HOLIDAYS);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map(normalizeDateKey));
    } catch {
      return new Set();
    }
  }

  function saveCompanyHolidays(set) {
    localStorage.setItem(STORAGE_COMPANY_HOLIDAYS, JSON.stringify(Array.from(set)));
  }

  function getOrDefaultRecord(dateKey) {
    const rec = db[dateKey];
    if (rec && typeof rec === "object") return sanitizeRecord(rec);
    return /** @type {DayRecord} */ ({
      kind: "normal",
      start: null,
      end: null,
      note: "",
      judged: false,
    });
  }

  function sanitizeRecord(r) {
    const kind = (r.kind === "paid" || r.kind === "holidayWork" || r.kind === "normal") ? r.kind : "normal";
    return /** @type {DayRecord} */ ({
      kind,
      start: typeof r.start === "string" && r.start ? r.start : null,
      end: typeof r.end === "string" && r.end ? r.end : null,
      note: typeof r.note === "string" ? r.note : "",
      judged: !!r.judged,
    });
  }

  function upsertRecord(dateKey, mutator) {
    const current = getOrDefaultRecord(dateKey);
    mutator(current);

    // If everything is default, we can delete to keep storage small
    const isDefault =
      current.kind === "normal" &&
      !current.start &&
      !current.end &&
      !current.note &&
      !current.judged;

    if (isDefault) {
      delete db[dateKey];
    } else {
      db[dateKey] = current;
    }
    saveDb();
  }

  function applyKindBtnColor(btn, kind) {
    btn.classList.remove("isNormal", "isSelected");
    if (kind === "normal") btn.classList.add("isNormal");
    else btn.classList.add("isSelected");
  }

  /* ========== Utilities: Date/Time in JST ========== */
  function getNowJst() {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date());
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second),
    };
  }

  function weekdayJst(year, month, day) {
    // Use UTC date with JST offset logic by formatting in TZ
    const d = makeDateObj(year, month, day);
    const w = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[w];
  }

  function makeDateObj(year, month, day) {
    // Create Date at 00:00 UTC then interpret in TZ via formatters.
    // For safety, we create a UTC midnight and let weekday calc use TZ.
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  }

  function addDaysJst(year, month, day, deltaDays) {
    const base = makeDateObj(year, month, day);
    const moved = new Date(base.getTime() + deltaDays * 86400000);
    // Extract Y/M/D in TZ
    const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = dtf.formatToParts(moved);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
  }

  function getDaysInMonth(year, month) {
    // month: 1-12
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function ymdKey(y, m, d) {
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function normalizeDateKey(v) {
    // accept "YYYY-MM-DD"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return v;
    return `${Number(m[1])}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  }

  function parseDateKeyMeta(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function timeToMin(t) {
    const [hh, mm] = t.split(":").map(Number);
    return hh * 60 + mm;
  }

  function compareTime(a, b) {
    return timeToMin(a) - timeToMin(b);
  }

  function minToHourStr(min) {
    // "H:MM" 形式（等幅）
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}:${pad2(m)}`;
  }

  function yen(n) {
    return `${Number(n).toLocaleString(LOCALE)}円`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  /* ========== SVG Icons ========== */
  function sparklesCircleSvg() {
    // “sparkles.circle” 風（自前SVG）
    // strokeで色を変えるので stroke属性はCSSで上書き
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke-width="2" />
        <path d="M12 7.2l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7.7-2.2Z" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M7.4 12.4l.4 1.3 1.3.4-1.3.4-.4 1.3-.4-1.3-1.3-.4 1.3-.4.4-1.3Z" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M16.8 12.1l.35 1.1 1.1.35-1.1.35-.35 1.1-.35-1.1-1.1-.35 1.1-.35.35-1.1Z" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
    `;
  }

  /* ========== Start ========== */
  init();

})();
