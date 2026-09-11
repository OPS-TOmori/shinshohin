/**
 * 商品マスタ登録サイト ― Google Apps Script バックエンド
 *
 * このスクリプトは、このコードが紐づいたGoogleスプレッドシートを
 * データベース代わりに使い、Webアプリとして公開することでフロントエンド
 * (public/app.js) からのAPIリクエストを受け付けます。
 *
 * ■ 使い方（README.md にも詳しい手順があります）
 * 1. Googleスプレッドシートを新規作成し、シート名を「商品マスタ」に変更
 * 2. 1行目に下記の見出し行(HEADERS)をそのまま入力
 * 3. 拡張機能 > Apps Script を開き、このファイルの内容を貼り付け
 * 4. 左メニューの「プロジェクトの設定」→「スクリプト プロパティ」で
 *    ACCESS_CODE（任意の合言葉）を追加（設定しない場合は認証なし）
 * 5. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」
 *    - 実行するユーザー: 自分
 *    - アクセスできるユーザー: 全員
 * 6. 発行されたウェブアプリのURL（.../exec で終わる）を
 *    public/app.js の APPS_SCRIPT_URL に設定
 */

const SHEET_NAME = "商品マスタ";
const IMAGE_FOLDER_NAME = "商品マスタ_画像";

// スプレッドシートの列構成（1行目の見出しと完全に一致させること）
const HEADERS = [
  "ID", "ブランド", "商品名", "品種", "画像URL", "色",
  "ページ数", "面数", "プロカラー金額", "年間受注数", "年間原価", "備考", "登録日時",
];
const COL = {}; // 1-indexed column numbers
HEADERS.forEach((h, i) => (COL[h] = i + 1));

// ---------------- エントリポイント ----------------

function doGet(e) {
  return handle(() => {
    const action = (e.parameter.action || "list");
    if (action === "ping") {
      return { ok: checkAuth(e.parameter.code), gateEnabled: isGateEnabled() };
    }
    if (!checkAuth(e.parameter.code)) return { error: "AUTH", message: "合言葉が正しくありません。" };
    if (action === "list") {
      return { records: listRecords(e.parameter.brand || "") };
    }
    return { error: "BAD_REQUEST", message: "不明なactionです: " + action };
  });
}

function doPost(e) {
  return handle(() => {
    const body = JSON.parse(e.postData.contents || "{}");
    if (!checkAuth(body.code)) return { error: "AUTH", message: "合言葉が正しくありません。" };

    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      if (body.action === "create") {
        return { record: createRecord(body.fields || {}, body.image || null) };
      }
      if (body.action === "update") {
        if (!body.id) return { error: "BAD_REQUEST", message: "idが指定されていません。" };
        return { record: updateRecord(body.id, body.fields || {}, body.image || null) };
      }
      if (body.action === "delete") {
        if (!body.id) return { error: "BAD_REQUEST", message: "idが指定されていません。" };
        deleteRecord(body.id);
        return { deleted: true };
      }
      return { error: "BAD_REQUEST", message: "不明なactionです: " + body.action };
    } finally {
      lock.releaseLock();
    }
  });
}

function handle(fn) {
  let result;
  try {
    result = fn();
  } catch (err) {
    result = { error: "SERVER_ERROR", message: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ---------------- 認証 ----------------

function isGateEnabled() {
  const code = PropertiesService.getScriptProperties().getProperty("ACCESS_CODE");
  return !!code;
}

function checkAuth(provided) {
  const required = PropertiesService.getScriptProperties().getProperty("ACCESS_CODE");
  if (!required) return true;
  return provided === required;
}

// ---------------- シート操作 ----------------

function getSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`シート「${SHEET_NAME}」が見つかりません。`);
  return sheet;
}

function rowToRecord(sheet, row) {
  const values = sheet.getRange(row, 1, 1, HEADERS.length).getValues()[0];
  const fields = {};
  HEADERS.forEach((h, i) => {
    fields[h] = values[i];
  });
  return { id: fields["ID"], row, fields };
}

function listRecords(brand) {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  const records = [];
  if (lastRow < 2) return records;
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  values.forEach((rowValues, idx) => {
    const id = rowValues[COL["ID"] - 1];
    if (!id) return; // 空行はスキップ
    if (brand && rowValues[COL["ブランド"] - 1] !== brand) return;
    const fields = {};
    HEADERS.forEach((h, i) => (fields[h] = rowValues[i]));
    records.push({ id, row: idx + 2, fields });
  });
  // 登録日時の新しい順
  records.sort((a, b) => {
    const da = a.fields["登録日時"] ? new Date(a.fields["登録日時"]).getTime() : 0;
    const db = b.fields["登録日時"] ? new Date(b.fields["登録日時"]).getTime() : 0;
    return db - da;
  });
  return records;
}

function findRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, COL["ID"], lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2;
  }
  return -1;
}

function createRecord(fields, image) {
  const sheet = getSheet();
  const newRow = sheet.getLastRow() + 1;
  const id = Utilities.getUuid();

  sheet.getRange(newRow, COL["ID"]).setValue(id);
  sheet.getRange(newRow, COL["ブランド"]).setValue(fields["ブランド"] || "");
  sheet.getRange(newRow, COL["商品名"]).setValue(fields["商品名"] || "");
  sheet.getRange(newRow, COL["品種"]).setValue(fields["品種"] || "");
  sheet.getRange(newRow, COL["色"]).setValue(fields["色"] || "");
  sheet.getRange(newRow, COL["ページ数"]).setValue(fields["ページ数"] != null ? fields["ページ数"] : "");
  sheet.getRange(newRow, COL["面数"]).setValue(fields["面数"] != null ? fields["面数"] : "");
  sheet.getRange(newRow, COL["プロカラー金額"]).setValue(Number(fields["プロカラー金額"]) || 0);
  sheet.getRange(newRow, COL["年間受注数"]).setValue(Number(fields["年間受注数"]) || 0);
  sheet
    .getRange(newRow, COL["年間原価"])
    .setFormula(`=${colLetter(COL["プロカラー金額"])}${newRow}*${colLetter(COL["年間受注数"])}${newRow}`);
  sheet.getRange(newRow, COL["備考"]).setValue(fields["備考"] || "");
  sheet.getRange(newRow, COL["登録日時"]).setValue(new Date());

  if (image && image.base64) {
    const url = saveImageToDrive(image);
    sheet.getRange(newRow, COL["画像URL"]).setValue(url);
  }

  SpreadsheetApp.flush();
  return rowToRecord(sheet, newRow);
}

function updateRecord(id, fields, image) {
  const sheet = getSheet();
  const row = findRowById(sheet, id);
  if (row === -1) throw new Error("指定されたIDの商品が見つかりません: " + id);

  const setIfProvided = (key, transform) => {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      const v = fields[key];
      sheet.getRange(row, COL[key]).setValue(transform ? transform(v) : v);
    }
  };
  setIfProvided("ブランド");
  setIfProvided("商品名");
  setIfProvided("品種");
  setIfProvided("色");
  setIfProvided("ページ数", (v) => (v != null && v !== "" ? Number(v) : ""));
  setIfProvided("面数", (v) => (v != null && v !== "" ? Number(v) : ""));
  setIfProvided("プロカラー金額", (v) => Number(v) || 0);
  setIfProvided("年間受注数", (v) => Number(v) || 0);
  setIfProvided("備考");

  // 単価 or 数量が変わっても年間原価の数式は行に対して不変なので再設定は不要だが、
  // 念のため式が壊れていないか確認・再設定する
  sheet
    .getRange(row, COL["年間原価"])
    .setFormula(`=${colLetter(COL["プロカラー金額"])}${row}*${colLetter(COL["年間受注数"])}${row}`);

  if (image && image.base64) {
    const oldUrl = sheet.getRange(row, COL["画像URL"]).getValue();
    if (oldUrl) trashDriveFileByUrl(oldUrl);
    const url = saveImageToDrive(image);
    sheet.getRange(row, COL["画像URL"]).setValue(url);
  }

  SpreadsheetApp.flush();
  return rowToRecord(sheet, row);
}

function deleteRecord(id) {
  const sheet = getSheet();
  const row = findRowById(sheet, id);
  if (row === -1) throw new Error("指定されたIDの商品が見つかりません: " + id);
  const oldUrl = sheet.getRange(row, COL["画像URL"]).getValue();
  if (oldUrl) trashDriveFileByUrl(oldUrl);
  sheet.deleteRow(row);
}

// ---------------- 画像(Google Drive) ----------------

function getImageFolder() {
  const folders = DriveApp.getFoldersByName(IMAGE_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(IMAGE_FOLDER_NAME);
}

function saveImageToDrive(image) {
  const folder = getImageFolder();
  const bytes = Utilities.base64Decode(image.base64);
  const blob = Utilities.newBlob(bytes, image.contentType || "image/jpeg", image.filename || "photo.jpg");
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return `https://drive.google.com/uc?export=view&id=${file.getId()}`;
}

function trashDriveFileByUrl(url) {
  try {
    const m = String(url).match(/id=([^&]+)/);
    if (!m) return;
    DriveApp.getFileById(m[1]).setTrashed(true);
  } catch (err) {
    // 画像が既に無い等は無視
  }
}

// ---------------- ユーティリティ ----------------

function colLetter(colIndex) {
  let letter = "";
  let n = colIndex;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
