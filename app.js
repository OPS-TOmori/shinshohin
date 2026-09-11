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
  const BRAND_LABELS = ["Az", "Cocoa", "グランフォト", "ブライダル", "アダマス"];

  let allRecords = [];
  let currentBrand = "";
  let currentHinshuFilter = "";

  // ---------------- ユーティリティ ----------------
  function yen(n) {
    const v = Number(n) || 0;
    return "¥" + v.toLocaleString("ja-JP");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

  function render() {
    const grand = computeSummary(allRecords);
    document.getElementById("grand-summary").textContent =
      `全ブランド合計: ${grand.count}品目 / 年間原価合計 ${yen(grand.total)}`;

    let filtered = currentBrand ? allRecords.filter((r) => r.fields["ブランド"] === currentBrand) : allRecords.slice();
    if (currentHinshuFilter) {
      filtered = filtered.filter((r) => r.fields["品種"] === currentHinshuFilter);
    }

    const brandSum = computeSummary(filtered);
    const label = currentBrand || "全ブランド";
    document.getElementById("brand-summary").innerHTML =
      `${label}: <strong>${brandSum.count}品目</strong> ／ 年間原価合計 <strong>${yen(brandSum.total)}</strong>`;

    const listArea = document.getElementById("list-area");

    if (filtered.length === 0) {
      listArea.innerHTML = `<p class="empty-note">該当する商品がまだ登録されていません。「＋ 新規登録」から追加してください。</p>`;
      return;
    }

    const grid = document.createElement("div");
    grid.className = "product-grid";
    filtered.forEach((rec) => grid.appendChild(renderCard(rec)));

    listArea.innerHTML = "";
    listArea.appendChild(grid);
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

    const specParts = [];
    if (f["色"]) specParts.push(`色: ${f["色"]}`);
    if (f["品種"] === "アルバム" && f["ページ数"] !== "" && f["ページ数"] != null) specParts.push(`${f["ページ数"]}ページ`);
    if (f["品種"] === "台紙" && f["面数"] !== "" && f["面数"] != null) specParts.push(`${f["面数"]}面`);

    card.insertAdjacentHTML(
      "beforeend",
      `<div class="body">
        <span class="brand-tag">${f["ブランド"] || ""} ・ ${f["品種"] || ""}</span>
        <div class="name">${f["商品名"] || "(名称未設定)"}</div>
        <div class="meta">${specParts.join(" / ")}</div>
        <div class="price-row"><span>プロカラー単価</span><span class="val">${yen(f["プロカラー金額"])}</span></div>
        <div class="price-row"><span>年間受注数</span><span class="val">${(Number(f["年間受注数"]) || 0).toLocaleString("ja-JP")}件</span></div>
        <div class="annual"><span>年間原価　</span><span class="val">${yen(annual)}</span></div>
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
  const fPageWrap = document.getElementById("f-page-wrap");
  const fPage = document.getElementById("f-page");
  const fMenWrap = document.getElementById("f-men-wrap");
  const fMen = document.getElementById("f-men");
  const fPrice = document.getElementById("f-price");
  const fQty = document.getElementById("f-qty");
  const fCalc = document.getElementById("f-calc");
  const fNote = document.getElementById("f-note");
  const formError = document.getElementById("form-error");

  function updateConditionalFields() {
    const h = fHinshu.value;
    fPageWrap.classList.toggle("hidden", h !== "アルバム");
    fMenWrap.classList.toggle("hidden", h !== "台紙");
  }
  fHinshu.addEventListener("change", updateConditionalFields);

  function updateCalcPreview() {
    const total = (Number(fPrice.value) || 0) * (Number(fQty.value) || 0);
    fCalc.textContent = yen(total);
  }
  fPrice.addEventListener("input", updateCalcPreview);
  fQty.addEventListener("input", updateCalcPreview);

  function resetForm() {
    form.reset();
    fId.value = "";
    fImagePreview.classList.add("hidden");
    fImagePreview.src = "";
    formError.classList.add("hidden");
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
      fPage.value = f["ページ数"] != null && f["ページ数"] !== "" ? f["ページ数"] : "";
      fMen.value = f["面数"] != null && f["面数"] !== "" ? f["面数"] : "";
      fPrice.value = f["プロカラー金額"] != null ? f["プロカラー金額"] : "";
      fQty.value = f["年間受注数"] != null ? f["年間受注数"] : "";
      fNote.value = f["備考"] || "";
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
        "プロカラー金額": Number(fPrice.value) || 0,
        "年間受注数": Number(fQty.value) || 0,
        "備考": fNote.value || "",
      };
      fields["ページ数"] = hinshu === "アルバム" && fPage.value !== "" ? Number(fPage.value) : "";
      fields["面数"] = hinshu === "台紙" && fMen.value !== "" ? Number(fMen.value) : "";

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
