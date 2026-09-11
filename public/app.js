// public/app.js
// 商品マスタ登録アプリのフロントエンド・ロジック。
// バックエンドは Google Apps Script のウェブアプリ(Code.gs)。
// Google スプレッドシートには直接アクセスせず、必ずこのウェブアプリURL経由で通信する。

(() => {
  // ここに Apps Script のウェブアプリURL(.../exec)を直接書いてもよい。
  // 空のままにしておくと、初回アクセス時に画面から入力・保存できる。
  const CONFIGURED_URL = "";

  const STORAGE_KEY_URL = "shohin_apps_script_url";
  const STORAGE_KEY_CODE = "shohin_access_code";
  const STORAGE_KEY_VIEW = "shohin_view_mode";
  const BRAND_LABELS = ["Az", "Cocoa", "グランフォト", "ブライダル", "アダマス"];

  let allRecords = [];
  let currentBrand = "";
  let currentHinshuFilter = "";
  let currentColorFilter = "";
  let currentPageFilter = "";
  let currentMenFilter = "";
  let currentSizeFilter = "";
  let currentKeyword = "";
  let currentElmMissingOnly = false;
  let currentView = localStorage.getItem(STORAGE_KEY_VIEW) === "table" ? "table" : "card";

  // ---------------- ユーティリティ ----------------
  function yen(n) {
    const v = Number(n) || 0;
    return "¥" + v.toLocaleString("ja-JP");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // "ページ別明細"列(JSON文字列)を配列に変換する。壊れている/未設定の場合はnull。
  function parseDetailJson(raw) {
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch (err) {
      return null;
    }
  }

  // エルムさんの見積が(一部でも)入力されているかどうか。
  function hasElmQuote(f) {
    return f["エルム年間原価"] != null && f["エルム年間原価"] !== "";
  }

  // 差額(削減額)・コストダウン率を計算する。未入力の場合はnullを返す。
  function computeElmComparison(procolorCost, elmCost) {
    if (elmCost == null || elmCost === "") return { diff: null, pct: null };
    const diff = (Number(procolorCost) || 0) - Number(elmCost);
    const base = Number(procolorCost) || 0;
    const pct = base > 0 ? (diff / base) * 100 : null;
    return { diff, pct };
  }

  // diff(=プロカラー原価-エルム原価)が正なら削減、負なら増加として文言を作る。
  function pctLabel(pct) {
    if (pct == null) return "―";
    if (pct === 0) return "±0%";
    return pct > 0 ? `${pct.toFixed(1)}%削減` : `${Math.abs(pct).toFixed(1)}%増加`;
  }

  function diffLabel(diff) {
    if (diff == null) return "未入力";
    if (diff === 0) return yen(0);
    return diff > 0 ? yen(diff) + " 減" : yen(Math.abs(diff)) + " 増";
  }

  function elmValClass(diff) {
    if (diff == null) return "val-muted";
    return diff >= 0 ? "val-save" : "val-loss";
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---------------- 接続先URL設定 ----------------
  function getAppsScriptUrl() {
    return CONFIGURED_URL || localStorage.getItem(STORAGE_KEY_URL) || "";
  }

  const urlSetupEl = document.getElementById("url-setup");
  const urlInput = document.getElementById("url-input");
  const urlError = document.getElementById("url-error");

  async function verifyUrl(url) {
    try {
      const res = await fetch(`${url}?action=ping&_=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      return typeof data.ok !== "undefined";
    } catch (err) {
      return false;
    }
  }

  document.getElementById("url-submit").addEventListener("click", async () => {
    const url = urlInput.value.trim().replace(/\/+$/, "");
    urlError.classList.add("hidden");
    if (!url) return;
    const btn = document.getElementById("url-submit");
    btn.disabled = true;
    btn.textContent = "接続確認中…";
    const ok = await verifyUrl(url);
    btn.disabled = false;
    btn.textContent = "保存して接続";
    if (ok) {
      localStorage.setItem(STORAGE_KEY_URL, url);
      urlSetupEl.classList.add("hidden");
      bootAuth();
    } else {
      urlError.classList.remove("hidden");
    }
  });

  document.getElementById("btn-settings").addEventListener("click", () => {
    urlInput.value = getAppsScriptUrl();
    document.getElementById("app").classList.add("hidden");
    document.getElementById("gate").classList.add("hidden");
    urlSetupEl.classList.remove("hidden");
  });

  // ---------------- 通信 ----------------
  function getAccessCode() {
    return sessionStorage.getItem(STORAGE_KEY_CODE) || "";
  }

  async function apiGet(params) {
    const url = getAppsScriptUrl();
    // "_" はキャッシュ回避用のダミーパラメータ。ブラウザ(や経路上のキャッシュ)が
    // 同一URLのGETレスポンスを使い回し、新規登録直後の一覧取得で古い(空の)結果が
    // 返ってきてしまう問題を防ぐために付与している。
    const qs = new URLSearchParams({ ...params, code: getAccessCode(), _: Date.now() }).toString();
    const res = await fetch(`${url}?${qs}`, { cache: "no-store" });
    const data = await res.json();
    if (data.error === "AUTH") {
      sessionStorage.removeItem(STORAGE_KEY_CODE);
      showGate(true);
      throw new Error("認証エラー: 合言葉を再入力してください。");
    }
    if (data.error) throw new Error(data.message || data.error);
    return data;
  }

  async function apiPost(body) {
    const url = getAppsScriptUrl();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // CORSプリフライトを避けるため text/plain を使用
      body: JSON.stringify({ ...body, code: getAccessCode() }),
    });
    const data = await res.json();
    if (data.error === "AUTH") {
      sessionStorage.removeItem(STORAGE_KEY_CODE);
      showGate(true);
      throw new Error("認証エラー: 合言葉を再入力してください。");
    }
    if (data.error) throw new Error(data.message || data.error);
    return data;
  }

  // ---------------- 合言葉ゲート ----------------
  const gateEl = document.getElementById("gate");
  const appEl = document.getElementById("app");
  const gateInput = document.getElementById("gate-input");
  const gateError = document.getElementById("gate-error");

  function showGate(showErrorMsg) {
    appEl.classList.add("hidden");
    gateEl.classList.remove("hidden");
    gateError.classList.toggle("hidden", !showErrorMsg);
    gateInput.value = "";
    gateInput.focus();
  }

  function showApp() {
    gateEl.classList.add("hidden");
    urlSetupEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    initApp();
  }

  async function tryUnlock(code) {
    try {
      const url = getAppsScriptUrl();
      const qs = new URLSearchParams({ action: "ping", code: code || "", _: Date.now() }).toString();
      const res = await fetch(`${url}?${qs}`, { cache: "no-store" });
      const data = await res.json();
      return !!data.ok;
    } catch (err) {
      return false;
    }
  }

  async function bootAuth() {
    if (!getAppsScriptUrl()) {
      urlSetupEl.classList.remove("hidden");
      return;
    }
    const okWithoutCode = await tryUnlock("");
    if (okWithoutCode) {
      showApp();
      return;
    }
    const saved = getAccessCode();
    if (saved) {
      const ok = await tryUnlock(saved);
      if (ok) {
        showApp();
        return;
      }
    }
    showGate(false);
  }

  document.getElementById("gate-submit").addEventListener("click", async () => {
    const code = gateInput.value.trim();
    const ok = await tryUnlock(code);
    if (ok) {
      sessionStorage.setItem(STORAGE_KEY_CODE, code);
      showApp();
    } else {
      gateError.classList.remove("hidden");
    }
  });
  gateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("gate-submit").click();
  });

  // ---------------- データ読み込み ----------------
  async function loadAll() {
    document.getElementById("list-area").innerHTML = `<p class="empty-note">読み込み中…</p>`;
    const data = await apiGet({ action: "list" });
    allRecords = data.records || [];
    populateFilterOptions();
    render();
  }

  // ---------------- 集計・描画 ----------------
  function computeSummary(records) {
    const count = records.length;
    const total = records.reduce(
      (sum, r) => sum + (Number(r.fields["年間原価"]) || (Number(r.fields["プロカラー金額"]) || 0) * (Number(r.fields["年間受注数"]) || 0)),
      0
    );
    return { count, total };
  }

  // ブランドタブ・品種/色/ページ数/面数の絞り込み・キーワード検索を全てAND条件で適用する。
  function matchesFilters(rec) {
    const f = rec.fields;
    if (currentBrand && f["ブランド"] !== currentBrand) return false;
    if (currentHinshuFilter && f["品種"] !== currentHinshuFilter) return false;
    if (currentColorFilter && (f["色"] || "") !== currentColorFilter) return false;
    if (currentPageFilter) {
      const pages = String(f["ページ数"] || "")
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!pages.includes(currentPageFilter)) return false;
    }
    if (currentMenFilter) {
      const men = f["面数"] != null && f["面数"] !== "" ? String(f["面数"]) : "";
      if (men !== currentMenFilter) return false;
    }
    if (currentSizeFilter) {
      const sizes = String(f["サイズ"] || "")
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!sizes.includes(currentSizeFilter)) return false;
    }
    if (currentElmMissingOnly && hasElmQuote(f)) return false;
    if (currentKeyword) {
      const kw = currentKeyword.toLowerCase();
      const hay = `${f["商品名"] || ""} ${f["備考"] || ""}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  }

  // 色・ページ数・面数の絞り込みプルダウンの選択肢を、現在登録されているデータから作り直す。
  function fillSelectOptions(selectEl, valuesSet, allLabel, sorter) {
    const current = selectEl.value;
    const values = Array.from(valuesSet);
    values.sort(sorter);
    selectEl.innerHTML =
      `<option value="">${allLabel}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    if (values.includes(current)) selectEl.value = current;
  }

  function populateFilterOptions() {
    const colors = new Set();
    const pages = new Set();
    const mens = new Set();
    const sizes = new Set();
    allRecords.forEach((rec) => {
      const f = rec.fields;
      if (f["色"]) colors.add(f["色"]);
      if (f["ページ数"]) {
        String(f["ページ数"])
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((p) => pages.add(p));
      }
      if (f["面数"] != null && f["面数"] !== "") mens.add(String(f["面数"]));
      if (f["サイズ"]) {
        String(f["サイズ"])
          .split("/")
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((s) => sizes.add(s));
      }
    });
    fillSelectOptions(document.getElementById("filter-color"), colors, "色（すべて）", (a, b) => a.localeCompare(b, "ja"));
    fillSelectOptions(document.getElementById("filter-page"), pages, "ページ数（すべて）", (a, b) => Number(a) - Number(b));
    fillSelectOptions(document.getElementById("filter-men"), mens, "面数（すべて）", (a, b) => Number(a) - Number(b));
    fillSelectOptions(document.getElementById("filter-size"), sizes, "サイズ（すべて）", (a, b) => a.localeCompare(b, "ja"));
  }

  function specLabel(f) {
    const parts = [];
    if (f["品種"] === "アルバム" && f["ページ数"] !== "" && f["ページ数"] != null) parts.push(`${f["ページ数"]}ページ`);
    if (f["品種"] === "台紙" && f["面数"] !== "" && f["面数"] != null) parts.push(`${f["面数"]}面`);
    if (f["サイズ"]) parts.push(`サイズ: ${f["サイズ"]}`);
    return parts.join(" / ");
  }

  function render() {
    const grand = computeSummary(allRecords);
    document.getElementById("grand-summary").textContent =
      `全ブランド合計: ${grand.count}品目 / 年間原価合計 ${yen(grand.total)}`;

    const filtered = allRecords.filter(matchesFilters);

    const brandSum = computeSummary(filtered);
    const label = currentBrand || "全ブランド";
    document.getElementById("brand-summary").innerHTML =
      `${label}: <strong>${brandSum.count}品目</strong> ／ 年間原価合計 <strong>${yen(brandSum.total)}</strong>`;

    const listArea = document.getElementById("list-area");

    if (filtered.length === 0) {
      listArea.innerHTML = `<p class="empty-note">該当する商品がまだ登録されていません。「＋ 新規登録」から追加するか、絞り込み条件を見直してください。</p>`;
      return;
    }

    if (currentView === "table") {
      renderTableView(listArea, filtered);
    } else {
      renderCardView(listArea, filtered);
    }
  }

  function renderCardView(listArea, filtered) {
    const grid = document.createElement("div");
    grid.className = "product-grid";
    filtered.forEach((rec) => grid.appendChild(renderCard(rec)));
    listArea.innerHTML = "";
    listArea.appendChild(grid);
  }

  function renderTableView(listArea, filtered) {
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "product-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>画像</th><th>ブランド</th><th>品種</th><th>商品名</th><th>色</th><th>仕様</th>
          <th>単価</th><th>年間受注数</th><th>年間原価</th>
          <th>エルム単価</th><th>エルム年間原価</th><th>原価差額</th><th>コストダウン率</th>
          <th>備考</th><th>操作</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    filtered.forEach((rec) => tbody.appendChild(renderTableRow(rec)));
    wrap.appendChild(table);
    listArea.innerHTML = "";
    listArea.appendChild(wrap);
  }

  function renderTableRow(rec) {
    const f = rec.fields;
    const tr = document.createElement("tr");
    const annual =
      f["年間原価"] != null && f["年間原価"] !== ""
        ? f["年間原価"]
        : (Number(f["プロカラー金額"]) || 0) * (Number(f["年間受注数"]) || 0);
    const thumbUrl = f["画像URL"] || null;
    const detail = parseDetailJson(f["ページ別明細"]);
    const priceLabel = detail && detail.length > 1 ? `平均 ${yen(f["プロカラー金額"])}` : yen(f["プロカラー金額"]);
    const elmQuoted = hasElmQuote(f);
    const { diff, pct } = computeElmComparison(annual, elmQuoted ? f["エルム年間原価"] : null);
    const elmPriceCell = elmQuoted ? yen(f["エルム単価"]) : `<span class="val-muted">未入力</span>`;
    const elmAnnualCell = elmQuoted ? yen(f["エルム年間原価"]) : `<span class="val-muted">未入力</span>`;
    const diffCell = `<span class="${elmValClass(diff)}">${diffLabel(diff)}</span>`;
    const pctCell = `<span class="${elmValClass(diff)}">${pctLabel(pct)}</span>`;

    tr.innerHTML = `
      <td class="thumb-cell">${
        thumbUrl ? `<img src="${thumbUrl}" referrerpolicy="no-referrer" />` : `<span class="thumb-none">画像なし</span>`
      }</td>
      <td>${escapeHtml(f["ブランド"] || "")}</td>
      <td>${escapeHtml(f["品種"] || "")}</td>
      <td class="name-cell">${escapeHtml(f["商品名"] || "(名称未設定)")}</td>
      <td>${escapeHtml(f["色"] || "")}</td>
      <td>${escapeHtml(specLabel(f))}</td>
      <td class="num-cell">${priceLabel}</td>
      <td class="num-cell">${(Number(f["年間受注数"]) || 0).toLocaleString("ja-JP")}件</td>
      <td class="annual-cell">${yen(annual)}</td>
      <td class="num-cell">${elmPriceCell}</td>
      <td class="num-cell">${elmAnnualCell}</td>
      <td class="num-cell">${diffCell}</td>
      <td class="num-cell">${pctCell}</td>
      <td class="note-cell">${escapeHtml(f["備考"] || "")}</td>
      <td class="actions-cell"></td>
    `;
    const actionsTd = tr.querySelector(".actions-cell");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "編集";
    editBtn.addEventListener("click", () => openModal(rec));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => onDelete(rec));
    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(delBtn);
    return tr;
  }

  function renderCard(rec) {
    const f = rec.fields;
    const card = document.createElement("div");
    card.className = "product-card";

    const thumbUrl = f["画像URL"] || null;
    const thumb = document.createElement(thumbUrl ? "img" : "div");
    thumb.className = "thumb";
    if (thumbUrl) {
      thumb.src = thumbUrl;
      thumb.alt = f["商品名"] || "";
      thumb.referrerPolicy = "no-referrer";
    } else {
      thumb.textContent = "画像なし";
    }
    card.appendChild(thumb);

    const annual = f["年間原価"] != null && f["年間原価"] !== "" ? f["年間原価"] : (Number(f["プロカラー金額"]) || 0) * (Number(f["年間受注数"]) || 0);
    const detail = parseDetailJson(f["ページ別明細"]);
    const priceLabelText = detail && detail.length > 1 ? "プロカラー単価(平均)" : "プロカラー単価";

    const specParts = [];
    if (f["色"]) specParts.push(`色: ${f["色"]}`);
    specParts.push(specLabel(f));

    const elmQuoted = hasElmQuote(f);
    const elmUnitLabel = detail && detail.length > 1 ? "エルム単価(平均)" : "エルム単価";
    const { diff, pct } = computeElmComparison(annual, elmQuoted ? f["エルム年間原価"] : null);
    const elmBlock = elmQuoted
      ? `<div class="price-row"><span>${elmUnitLabel}</span><span class="val">${yen(f["エルム単価"])}</span></div>
         <div class="price-row"><span>エルム年間原価</span><span class="val">${yen(f["エルム年間原価"])}</span></div>
         <div class="price-row"><span>原価差額</span><span class="val ${elmValClass(diff)}">${diffLabel(diff)}</span></div>
         <div class="price-row"><span>コストダウン率</span><span class="val ${elmValClass(diff)}">${pctLabel(pct)}</span></div>`
      : `<div class="price-row"><span>エルムさんの見積</span><span class="val val-muted">未入力</span></div>`;

    card.insertAdjacentHTML(
      "beforeend",
      `<div class="body">
        <span class="brand-tag">${f["ブランド"] || ""} ・ ${f["品種"] || ""}</span>
        <div class="name">${f["商品名"] || "(名称未設定)"}</div>
        <div class="meta">${specParts.filter(Boolean).join(" / ")}</div>
        <div class="price-row"><span>${priceLabelText}</span><span class="val">${yen(f["プロカラー金額"])}</span></div>
        <div class="price-row"><span>年間受注数</span><span class="val">${(Number(f["年間受注数"]) || 0).toLocaleString("ja-JP")}件</span></div>
        <div class="annual"><span>年間原価　</span><span class="val">${yen(annual)}</span></div>
        <div class="elm-compare">${elmBlock}</div>
        ${f["備考"] ? `<div class="note">${escapeHtml(f["備考"])}</div>` : ""}
      </div>
      <div class="actions">
        <button class="btn-edit">編集</button>
        <button class="btn-delete danger">削除</button>
      </div>`
    );

    card.querySelector(".btn-edit").addEventListener("click", () => openModal(rec));
    card.querySelector(".btn-delete").addEventListener("click", () => onDelete(rec));

    return card;
  }

  // ---------------- タブ・フィルタ ----------------
  document.getElementById("brand-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    currentBrand = btn.dataset.brand;
    render();
  });

  document.getElementById("filter-hinshu").addEventListener("change", (e) => {
    currentHinshuFilter = e.target.value;
    render();
  });

  document.getElementById("filter-color").addEventListener("change", (e) => {
    currentColorFilter = e.target.value;
    render();
  });

  document.getElementById("filter-page").addEventListener("change", (e) => {
    currentPageFilter = e.target.value;
    render();
  });

  document.getElementById("filter-men").addEventListener("change", (e) => {
    currentMenFilter = e.target.value;
    render();
  });

  document.getElementById("filter-size").addEventListener("change", (e) => {
    currentSizeFilter = e.target.value;
    render();
  });

  document.getElementById("filter-keyword").addEventListener("input", (e) => {
    currentKeyword = e.target.value.trim();
    render();
  });

  document.getElementById("filter-elm-missing").addEventListener("change", (e) => {
    currentElmMissingOnly = e.target.checked;
    render();
  });

  document.getElementById("btn-filter-clear").addEventListener("click", () => {
    currentHinshuFilter = "";
    currentColorFilter = "";
    currentPageFilter = "";
    currentMenFilter = "";
    currentSizeFilter = "";
    currentKeyword = "";
    currentElmMissingOnly = false;
    document.getElementById("filter-hinshu").value = "";
    document.getElementById("filter-color").value = "";
    document.getElementById("filter-page").value = "";
    document.getElementById("filter-men").value = "";
    document.getElementById("filter-size").value = "";
    document.getElementById("filter-keyword").value = "";
    document.getElementById("filter-elm-missing").checked = false;
    render();
  });

  document.getElementById("view-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".view-btn");
    if (!btn) return;
    currentView = btn.dataset.view;
    localStorage.setItem(STORAGE_KEY_VIEW, currentView);
    document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === currentView));

  // ---------------- モーダル(登録・編集) ----------------
  const modalOverlay = document.getElementById("modal-overlay");
  const form = document.getElementById("product-form");
  const fId = document.getElementById("f-id");
  const fBrand = document.getElementById("f-brand");
  const fName = document.getElementById("f-name");
  const fHinshu = document.getElementById("f-hinshu");
  const fImage = document.getElementById("f-image");
  const fImagePreview = document.getElementById("f-image-preview");
  const fColor = document.getElementById("f-color");
  const fMenWrap = document.getElementById("f-men-wrap");
  const fMen = document.getElementById("f-men");
  const fPagesDetailWrap = document.getElementById("f-pages-detail-wrap");
  const pagesDetailLabelText = document.getElementById("pages-detail-label-text");
  const pagesDetailList = document.getElementById("pages-detail-list");
  const btnAddPageLine = document.getElementById("btn-add-page-line");
  const pagesDetailTotal = document.getElementById("pages-detail-total");
  const pagesDetailElmTotal = document.getElementById("pages-detail-elm-total");
  const pagesDetailDiff = document.getElementById("pages-detail-diff");
  const pagesDetailPct = document.getElementById("pages-detail-pct");
  const fNote = document.getElementById("f-note");
  const formError = document.getElementById("form-error");

  // 品種によって明細行の1列目が「ページ数」(アルバム)か「サイズ」(それ以外)かが変わる。
  function lineLabelWord() {
    return fHinshu.value === "アルバム" ? "ページ数" : "サイズ";
  }

  // 品種切り替え時に、見出し文言・既存行のプレースホルダー・追加ボタンの文言を更新する。
  function refreshLineLabels() {
    const word = lineLabelWord();
    pagesDetailLabelText.textContent = `${word}ごとの単価・年間受注数・エルム見積（複数登録できます）`;
    btnAddPageLine.textContent = `＋ ${word}を追加`;
    document.querySelectorAll(".pl-pages").forEach((input) => {
      input.placeholder = word;
    });
  }

  function updateConditionalFields() {
    const h = fHinshu.value;
    fMenWrap.classList.toggle("hidden", h !== "台紙");
    if (pagesDetailList.children.length === 0) {
      addPageLine();
    }
    refreshLineLabels();
  }
  fHinshu.addEventListener("change", updateConditionalFields);

  // ---------------- ページ数/サイズごとの明細行 ----------------
  function createPageLineRow(data) {
    const row = document.createElement("div");
    row.className = "page-line-row";
    row.innerHTML = `
      <div class="pl-body">
        <div class="pl-inputs">
          <input type="text" class="pl-pages" placeholder="${lineLabelWord()}" value="${data && data.pages != null ? data.pages : ""}" />
          <input type="number" class="pl-price" placeholder="プロカラー単価" min="0" step="1" value="${data && data.price != null ? data.price : ""}" />
          <input type="number" class="pl-elm" placeholder="エルム単価(任意)" min="0" step="1" value="${data && data.elmPrice != null ? data.elmPrice : ""}" />
          <input type="number" class="pl-qty" placeholder="年間受注数" min="0" step="1" value="${data && data.qty != null ? data.qty : ""}" />
        </div>
        <div class="pl-subtotal-line"><span class="pl-subtotal"></span></div>
      </div>
      <button type="button" class="pl-remove" title="この行を削除">×</button>
    `;
    const priceInput = row.querySelector(".pl-price");
    const elmInput = row.querySelector(".pl-elm");
    const qtyInput = row.querySelector(".pl-qty");
    const subtotalEl = row.querySelector(".pl-subtotal");
    const updateRowSubtotal = () => {
      const price = Number(priceInput.value) || 0;
      const qty = Number(qtyInput.value) || 0;
      const elmPrice = Number(elmInput.value) || 0;
      const sub = price * qty;
      let text = `プロカラー小計 ${yen(sub)}`;
      text += elmPrice > 0 ? ` ／ エルム小計 ${yen(elmPrice * qty)}` : ` ／ エルム小計 未入力`;
      subtotalEl.textContent = text;
      updateCalcPreview();
    };
    priceInput.addEventListener("input", updateRowSubtotal);
    elmInput.addEventListener("input", updateRowSubtotal);
    qtyInput.addEventListener("input", updateRowSubtotal);
    row.querySelector(".pl-pages").addEventListener("input", updateCalcPreview);
    row.querySelector(".pl-remove").addEventListener("click", () => {
      row.remove();
      updateCalcPreview();
    });
    updateRowSubtotal();
    return row;
  }

  function addPageLine(data) {
    pagesDetailList.appendChild(createPageLineRow(data));
  }

  btnAddPageLine.addEventListener("click", () => addPageLine());

  function collectPageLines() {
    const isAlbum = fHinshu.value === "アルバム";
    return Array.from(pagesDetailList.querySelectorAll(".page-line-row"))
      .map((row) => {
        const raw = row.querySelector(".pl-pages").value;
        let label = "";
        if (raw !== "") {
          // アルバムは数値として扱う(数値変換できない場合は文字列のまま保持)。
          label = isAlbum && !isNaN(Number(raw)) ? Number(raw) : raw;
        }
        return {
          pages: label,
          price: Number(row.querySelector(".pl-price").value) || 0,
          qty: Number(row.querySelector(".pl-qty").value) || 0,
          elmPrice: row.querySelector(".pl-elm").value !== "" ? Number(row.querySelector(".pl-elm").value) : "",
        };
      })
      .filter((line) => line.pages !== "" || line.price > 0 || line.qty > 0 || line.elmPrice !== "");
  }

  // プロカラー原価・エルム原価(集計)・差額・コストダウン率を計算して表示する。
  // アルバム(複数行の合計)/それ以外(単一値)の両方で共通のロジックを使う。
  function renderElmSummary(procolorCost, elmQty, elmCost, els) {
    els.procolor.textContent = yen(procolorCost);
    const hasElm = elmQty > 0;
    if (!hasElm) {
      els.elm.textContent = "未入力";
      els.elm.className = "val-muted";
      els.diff.textContent = "未入力";
      els.diff.className = "val-muted";
      els.pct.textContent = "未入力";
      els.pct.className = "val-muted";
      return;
    }
    const { diff, pct } = computeElmComparison(procolorCost, elmCost);
    els.elm.textContent = yen(elmCost);
    els.elm.className = "";
    els.diff.textContent = diffLabel(diff);
    els.diff.className = elmValClass(diff);
    els.pct.textContent = pctLabel(pct);
    els.pct.className = elmValClass(diff);
  }

  function updateCalcPreview() {
    const lines = collectPageLines();
    const procolorCost = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
    let elmQty = 0;
    let elmCost = 0;
    lines.forEach((l) => {
      const ep = Number(l.elmPrice) || 0;
      if (ep > 0) {
        elmQty += l.qty;
        elmCost += ep * l.qty;
      }
    });
    renderElmSummary(procolorCost, elmQty, elmCost, {
      procolor: pagesDetailTotal,
      elm: pagesDetailElmTotal,
      diff: pagesDetailDiff,
      pct: pagesDetailPct,
    });
  }

  function resetForm() {
    form.reset();
    fId.value = "";
    fImagePreview.classList.add("hidden");
    fImagePreview.src = "";
    formError.classList.add("hidden");
    pagesDetailList.innerHTML = "";
    updateConditionalFields();
    updateCalcPreview();
  }

  function openModal(rec) {
    resetForm();
    document.getElementById("modal-title").textContent = rec ? "商品を編集" : "商品を登録";
    if (rec) {
      const f = rec.fields;
      fId.value = rec.id;
      fBrand.value = f["ブランド"] || (currentBrand || BRAND_LABELS[0]);
      fName.value = f["商品名"] || "";
      fHinshu.value = f["品種"] || "アルバム";
      fColor.value = f["色"] || "";
      fMen.value = f["面数"] != null && f["面数"] !== "" ? f["面数"] : "";
      fNote.value = f["備考"] || "";

      pagesDetailList.innerHTML = "";
      const detail = parseDetailJson(f["ページ別明細"]);
      if (detail) {
        detail.forEach((line) => addPageLine(line));
      } else {
        // 旧形式(ページ数/サイズが単一値だった頃)のレコードは1行分として読み込む
        const legacyLabel = fHinshu.value === "アルバム" ? f["ページ数"] : f["サイズ"];
        const hasLegacyValue =
          (legacyLabel !== "" && legacyLabel != null) ||
          (f["プロカラー金額"] != null && Number(f["プロカラー金額"]) !== 0) ||
          (f["年間受注数"] != null && Number(f["年間受注数"]) !== 0);
        if (hasLegacyValue) {
          addPageLine({
            pages: legacyLabel,
            price: f["プロカラー金額"],
            qty: f["年間受注数"],
            elmPrice: f["エルム単価"],
          });
        } else {
          addPageLine();
        }
      }

      if (f["画像URL"]) {
        fImagePreview.src = f["画像URL"];
        fImagePreview.classList.remove("hidden");
      }
      updateConditionalFields();
      updateCalcPreview();
    } else {
      fBrand.value = currentBrand || BRAND_LABELS[0];
      updateConditionalFields();
    }
    modalOverlay.classList.remove("hidden");
  }

  function closeModal() {
    modalOverlay.classList.add("hidden");
  }

  document.getElementById("btn-new").addEventListener("click", () => openModal(null));
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  fImage.addEventListener("change", () => {
    const file = fImage.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      fImagePreview.src = reader.result;
      fImagePreview.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.classList.add("hidden");
    const saveBtn = document.getElementById("btn-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";

    try {
      const hinshu = fHinshu.value;
      const fields = {
        "ブランド": fBrand.value,
        "商品名": fName.value || "",
        "品種": hinshu,
        "色": fColor.value || "",
        "備考": fNote.value || "",
      };
      fields["面数"] = hinshu === "台紙" && fMen.value !== "" ? Number(fMen.value) : "";

      const isAlbum = hinshu === "アルバム";
      const lines = collectPageLines();
      if (lines.length === 0) {
        throw new Error(`${lineLabelWord()}の明細を1件以上入力してください。`);
      }
      const totalQty = lines.reduce((sum, l) => sum + l.qty, 0);
      const totalCost = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
      const joinedLabel = lines
        .map((l) => l.pages)
        .filter((p) => p !== "")
        .join("/");
      fields["ページ別明細"] = JSON.stringify(lines);
      fields["ページ数"] = isAlbum ? joinedLabel : "";
      fields["サイズ"] = isAlbum ? "" : joinedLabel;
      fields["プロカラー金額"] = totalQty > 0 ? Math.round(totalCost / totalQty) : 0;
      fields["年間受注数"] = totalQty;

      const payload = { fields };
      const file = fImage.files[0];
      if (file) {
        payload.image = {
          base64: await fileToBase64(file),
          filename: file.name,
          contentType: file.type || "image/jpeg",
        };
      }

      const id = fId.value;
      if (id) {
        await apiPost({ action: "update", id, ...payload });
      } else {
        await apiPost({ action: "create", ...payload });
      }
      closeModal();
      // 保存自体は成功しているので、ここから先(一覧の再読み込み)が失敗しても
      // モーダルは閉じたまま進める。ただしエラーを隠さないよう、モーダルが
      // 既に閉じていても見える形(alert)で必ず知らせる。
      try {
        await loadAll();
      } catch (refreshErr) {
        alert(
          "保存は完了しましたが、一覧の再読み込みに失敗しました。\n" +
            refreshErr.message +
            "\n\n画面を再読み込み(F5)してご確認ください。"
        );
      }
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.remove("hidden");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  });

  async function onDelete(rec) {
    const name = rec.fields["商品名"] || "この商品";
    if (!confirm(`「${name}」を削除します。よろしいですか？`)) return;
    try {
      await apiPost({ action: "delete", id: rec.id });
      await loadAll();
    } catch (err) {
      alert("削除に失敗しました: " + err.message);
    }
  }

  // ---------------- 初期化 ----------------
  function initApp() {
    loadAll().catch((err) => {
      document.getElementById("list-area").innerHTML = `<p class="empty-note error">読み込みに失敗しました: ${escapeHtml(err.message)}</p>`;
    });
  }

  bootAuth();
})();
