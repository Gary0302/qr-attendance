/**
 * QR Code 點名與加分系統 —— 後端 API
 *
 * 部署方式：Apps Script 編輯器 →「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *   執行身分：我
 *   誰可以存取：所有人（Anyone）
 * 取得的 /exec 網址請填入前端 config.js 的 API_URL。
 *
 * 第一次使用：
 *   1. 先把 roster.csv 匯入「名冊」工作表（見 README）
 *   2. 再手動執行一次 setupSheets()，補上標題與格式
 */

var CONFIG = {
  SHEET_NAME: '名冊',        // 主資料表
  LOG_SHEET_NAME: '紀錄',    // 逐筆稽核紀錄
  TIMEZONE: 'Asia/Taipei',
  TIME_FORMAT: 'yyyy-MM-dd HH:mm:ss',

  // 選填：在 QR 網址加上 &token=xxxx，這裡填同樣的字串就會驗證。
  // 留空代表不驗證。注意這只是「防止隨手亂打」，不是真正的安全機制——
  // 任何拿到 QR 的人都看得到 token。真正要防重複請用 session 去重。
  TOKEN: '',

  DEFAULT_POINTS: 1,   // 未指定 points 時，一次加幾分
  MAX_POINTS: 10,      // points 參數上限，避免有人竄改網址狂加分

  // ── 輪替式 QR（防止截圖轉傳）────────────────────────────
  // 教師端每 ROTATE_PERIOD_SEC 秒重新產生一次 QR，網址帶簽章碼。
  // 密鑰存在「指令碼屬性」而非這份原始碼，因為 repo 是公開的。
  // 啟用：在編輯器執行 setRotateSecret('你自己想的一串密語')
  // 停用：執行 clearRotateSecret()
  ROTATE_PERIOD_SEC: 30,   // 每 30 秒換一次碼
  ROTATE_SLOP_SLOTS: 1,    // 容許誤差 ±1 格 → 一個碼實際可用約 30~90 秒
  ROTATE_CODE_LEN: 10,     // 簽章碼長度（hex 字元數）

  // ── 一機一人（防止用自己手機幫朋友簽到）──────────────────
  // 同一台裝置在同一場次最多可登記幾個不同學號。0 = 不限制。
  MAX_STUDENTS_PER_DEVICE: 1,

  // 只允許名單上的學號簽到；false 則未在名單者自動新增資料列並標記。
  ROSTER_ONLY: false,

  STUDENT_ID_PATTERN: /^[A-Za-z0-9._-]{2,20}$/
};

/* 欄位對應：A~F 來自學務系統名單，G~I 為本系統寫入 */
var COL = {
  SEQ: 1,            // A 序號
  ID: 2,             // B 學號       ← 查詢鍵
  NAME: 3,           // C 姓名
  GRADE: 4,          // D 年級
  EMAIL: 5,          // E 電子信箱
  ENROLLED: 6,       // F 選上否
  ATTENDANCE: 7,     // G 出席時間
  CLASS_BONUS: 8,    // H 課堂加分
  LECTURE_BONUS: 9   // I 講座加分
};

var HEADERS = ['序號', '學號', '姓名', '年級', '電子信箱', '選上否', '出席時間', '課堂加分', '講座加分'];
var LOG_HEADERS = ['送出時間', '模式', '學號', '送出姓名', '名冊姓名', '場次', '分數', '結果', '備註', '裝置'];

var MODE_TO_COL = {
  classBonus: COL.CLASS_BONUS,
  lectureBonus: COL.LECTURE_BONUS
};

var MODE_LABEL = {
  attendance: '點名',
  classBonus: '課堂加分',
  lectureBonus: '講座加分'
};


/* ============================ 進入點 ============================ */

/** GET：存活性確認（在瀏覽器直接打開 /exec 就能看到）。 */
function doGet(e) {
  return jsonOut({
    status: 'success',
    message: 'QR 點名系統 API 運作中',
    studentName: '',
    time: nowString()
  });
}

/** POST：寫入與更新。 */
function doPost(e) {
  var req = {};
  try {
    req = parseRequest(e);
  } catch (err) {
    return jsonOut({ status: 'error', message: String(err.message || err), studentName: '' });
  }

  var lock = LockService.getScriptLock();
  // 全班同時掃碼時，用鎖確保一次只有一個請求在讀寫試算表，避免覆蓋彼此的分數。
  try {
    lock.waitLock(28000);
  } catch (err) {
    return jsonOut({ status: 'error', message: '系統忙碌中，請稍候幾秒再送出一次。', studentName: '' });
  }

  try {
    var result = handle(req);
    writeLog(req, result);
    return jsonOut({
      status: result.status,
      message: result.message,
      studentName: result.studentName || ''
    });
  } catch (err) {
    var msg = '伺服器錯誤：' + String(err && err.message || err);
    try { writeLog(req, { status: 'error', message: msg, studentName: '' }); } catch (ignored) {}
    return jsonOut({ status: 'error', message: msg, studentName: '' });
  } finally {
    lock.releaseLock();
  }
}


/* ============================ 請求解析 ============================ */

function parseRequest(e) {
  var raw = {};

  // 前端以 text/plain 送 JSON（避開 CORS preflight）；
  // 同時相容表單格式與網址查詢字串，方便用 curl 測試。
  if (e && e.postData && e.postData.contents) {
    var body = String(e.postData.contents).trim();
    if (body.charAt(0) === '{') {
      try { raw = JSON.parse(body); }
      catch (err) { throw new Error('資料格式錯誤，無法解析 JSON。'); }
    }
  }
  if (e && e.parameter) {
    for (var k in e.parameter) {
      if (raw[k] === undefined || raw[k] === '') raw[k] = e.parameter[k];
    }
  }

  var mode = String(raw.mode || 'attendance').trim();
  if (mode !== 'attendance' && mode !== 'classBonus' && mode !== 'lectureBonus') {
    throw new Error('不支援的模式：' + mode);
  }

  if (CONFIG.TOKEN && String(raw.token || '') !== CONFIG.TOKEN) {
    throw new Error('這個 QR Code 已失效，請掃描老師目前投影的 QR Code。');
  }

  var studentId = String(raw.studentId || '').trim().toUpperCase().replace(/\s+/g, '');
  var studentName = String(raw.studentName || '').trim().replace(/[\s　]+/g, ' ');

  if (!studentId) throw new Error('缺少學號，無法簽到。');
  if (!studentName) throw new Error('缺少姓名，無法簽到。');
  if (!CONFIG.STUDENT_ID_PATTERN.test(studentId)) throw new Error('學號格式不正確：' + studentId);
  if (studentName.length > 30) throw new Error('姓名過長。');

  var points = parseInt(raw.points, 10);
  if (!points || points < 1) points = CONFIG.DEFAULT_POINTS;
  points = Math.min(points, CONFIG.MAX_POINTS);

  return {
    mode: mode,
    studentId: studentId,
    studentName: studentName,
    session: String(raw.session || '').trim(),
    points: points,
    slot: String(raw.s || '').trim(),          // QR 產生時的時間格
    code: String(raw.c || '').trim(),          // 該時間格的簽章碼
    deviceId: String(raw.dev || '').trim().slice(0, 40)
  };
}


/* ============================ 主要邏輯 ============================ */

function handle(req) {
  // 輪替碼驗證：設了密鑰就強制檢查，舊的截圖會被擋下。
  var rot = verifyRotation(req);
  if (!rot.ok) {
    return { status: 'error', message: rot.message, studentName: req.studentName, note: rot.note };
  }

  // 一機一人：同一台手機不能在同一場次幫別人簽到。
  var dev = checkDevice(req);
  if (!dev.ok) {
    return { status: 'error', message: dev.message, studentName: req.studentName, note: dev.note };
  }

  var sheet = getSheet(CONFIG.SHEET_NAME, HEADERS);

  // 同一場次不重複計分：QR 網址有帶 session 時才啟用。
  if (req.session && req.mode !== 'attendance') {
    if (alreadyCounted(req)) {
      var known = findRow(sheet, req.studentId);
      return {
        status: 'error',
        message: '你已經登記過這一場的' + MODE_LABEL[req.mode] + '了，不會重複計分。',
        studentName: known ? known.name : req.studentName,
        note: '重複場次 ' + req.session
      };
    }
  }

  var found = findRow(sheet, req.studentId);
  var row, canonicalName, created = false;

  if (found) {
    row = found.row;
    canonicalName = found.name || req.studentName;
    if (!found.name) {
      // 名冊有學號但沒姓名，補上。
      sheet.getRange(row, COL.NAME).setValue(req.studentName);
      canonicalName = req.studentName;
    }
  } else {
    if (CONFIG.ROSTER_ONLY) {
      return {
        status: 'error',
        message: '查無此學號（' + req.studentId + '），請確認是否輸入錯誤，或舉手告知老師。',
        studentName: req.studentName,
        note: '不在名冊'
      };
    }
    // 學號不存在時自動建立資料列，並標記為非名冊學生。
    row = sheet.getLastRow() + 1;
    sheet.getRange(row, COL.SEQ, 1, HEADERS.length).setValues([[
      nextSeq(sheet), req.studentId, req.studentName, '', '', '未在名單', '', 0, 0
    ]]);
    sheet.getRange(row, COL.ID).setNumberFormat('@');
    canonicalName = req.studentName;
    created = true;
  }

  var note = created ? '新建資料列（未在名單）' : '';
  // 姓名以名冊為準，避免有人打錯字或改掉別人的姓名；不一致時記在紀錄表供老師核對。
  // 比對時忽略全形/半形空白：學務系統會把兩字姓名補成「王　明」，
  // 但學生自己通常只會打「王明」。
  if (!created && squash(canonicalName) !== squash(req.studentName)) {
    note = '姓名不符（名冊：' + canonicalName + '）';
  }

  if (req.mode === 'attendance') {
    var now = new Date();
    var cell = sheet.getRange(row, COL.ATTENDANCE);
    cell.setValue(now);
    cell.setNumberFormat(CONFIG.TIME_FORMAT);
    markSession(req);
    markDevice(req);
    return {
      status: 'success',
      message: '已記錄簽到時間 ' + formatTime(now) + '。',
      studentName: canonicalName,
      note: note
    };
  }

  var col = MODE_TO_COL[req.mode];
  var cellB = sheet.getRange(row, col);
  var current = Number(cellB.getValue()) || 0;
  var total = current + req.points;
  cellB.setValue(total);
  markSession(req);
  markDevice(req);

  return {
    status: 'success',
    message: MODE_LABEL[req.mode] + ' +' + req.points + '，目前累計 ' + total + ' 分。',
    studentName: canonicalName,
    note: note
  };
}


/* ============================ 試算表工具 ============================ */

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** 以學號找出資料列（B 欄）；找不到回傳 null。 */
function findRow(sheet, studentId) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var values = sheet.getRange(2, COL.ID, last - 1, 2).getValues(); // B 學號, C 姓名
  for (var i = 0; i < values.length; i++) {
    var id = String(values[i][0]).trim().toUpperCase();
    if (id === studentId) {
      return { row: i + 2, name: String(values[i][1]).trim() };
    }
  }
  return null;
}

/** 下一個序號 = 目前最大序號 + 1（不受排序影響）。 */
function nextSeq(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return 1;
  var values = sheet.getRange(2, COL.SEQ, last - 1, 1).getValues();
  var max = 0;
  for (var i = 0; i < values.length; i++) {
    var n = parseInt(values[i][0], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function writeLog(req, result) {
  if (!CONFIG.LOG_SHEET_NAME) return;
  var sheet = getSheet(CONFIG.LOG_SHEET_NAME, LOG_HEADERS);
  sheet.appendRow([
    formatTime(new Date()),
    MODE_LABEL[req.mode] || req.mode || '',
    req.studentId || '',
    req.studentName || '',
    result.studentName || '',
    req.session || '',
    req.mode === 'attendance' ? '' : (req.points || ''),
    result.status === 'success' ? '成功' : '失敗',
    result.note || (result.status === 'success' ? '' : result.message) || '',
    req.deviceId ? req.deviceId.slice(0, 8) : ''
  ]);
}


/* ======================= 輪替式 QR 驗證 ======================= */
/*
 * 目的：學生把 QR 截圖傳給沒來的同學也沒用，因為碼只活 30~90 秒。
 *
 * 教師端 qr.html 每 30 秒重算一次：
 *   slot = floor(現在秒數 / 30)
 *   code = HMAC-SHA256(密鑰, "mode|session|slot") 取前 10 個 hex 字元
 * 並把 &s=<slot>&c=<code> 放進 QR 的網址。
 *
 * 後端重算同樣的值比對，並確認 slot 和伺服器當下時間相差不超過 ±1 格。
 * 密鑰只存在「指令碼屬性」，不在這份公開的原始碼裡。
 */

var ROTATE_SECRET_KEY = 'ROTATE_SECRET';

function getRotateSecret() {
  return PropertiesService.getScriptProperties().getProperty(ROTATE_SECRET_KEY) || '';
}

/** 在編輯器執行一次來啟用輪替式 QR。教師端 qr.html 要輸入同一串密語。 */
function setRotateSecret(secret) {
  secret = String(secret || '').trim();
  if (secret.length < 8) {
    throw new Error('密語太短，請用至少 8 個字元。');
  }
  PropertiesService.getScriptProperties().setProperty(ROTATE_SECRET_KEY, secret);
  Logger.log('輪替式 QR 已啟用。請在 qr.html 輸入同一串密語。');
}

/** 停用輪替式 QR（回到固定網址）。 */
function clearRotateSecret() {
  PropertiesService.getScriptProperties().deleteProperty(ROTATE_SECRET_KEY);
  Logger.log('輪替式 QR 已停用。');
}

/** HMAC-SHA256 轉小寫 hex。注意 Apps Script 的位元組是有號的，要補回 256。 */
function hmacHex(secret, message) {
  var raw = Utilities.computeHmacSha256Signature(message, secret);
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var b = raw[i] < 0 ? raw[i] + 256 : raw[i];
    var h = b.toString(16);
    out += (h.length === 1 ? '0' : '') + h;
  }
  return out;
}

function expectedCode(secret, mode, session, slot) {
  return hmacHex(secret, mode + '|' + session + '|' + slot).slice(0, CONFIG.ROTATE_CODE_LEN);
}

function currentSlot() {
  return Math.floor(Date.now() / 1000 / CONFIG.ROTATE_PERIOD_SEC);
}

/** 定時比較，避免用字串比較的耗時差異洩漏資訊。 */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function verifyRotation(req) {
  var secret = getRotateSecret();
  if (!secret) return { ok: true };   // 未啟用就不檢查

  if (!req.slot || !req.code) {
    return {
      ok: false,
      message: '這個 QR Code 沒有有效的簽到碼，請掃描老師螢幕上現在顯示的 QR Code。',
      note: '缺少輪替碼'
    };
  }

  var slot = parseInt(req.slot, 10);
  if (!slot || slot < 0) {
    return { ok: false, message: '簽到碼格式錯誤，請重新掃描。', note: '輪替碼格式錯誤' };
  }

  var drift = Math.abs(currentSlot() - slot);
  if (drift > CONFIG.ROTATE_SLOP_SLOTS) {
    var secs = drift * CONFIG.ROTATE_PERIOD_SEC;
    return {
      ok: false,
      message: '這個 QR Code 已經過期了（約 ' + secs + ' 秒前的碼）。'
             + '請重新掃描老師螢幕上現在顯示的 QR Code。',
      note: '輪替碼過期 ' + secs + ' 秒'
    };
  }

  if (!safeEqual(req.code, expectedCode(secret, req.mode, req.session, String(slot)))) {
    return {
      ok: false,
      message: '簽到碼不正確，請重新掃描老師螢幕上的 QR Code。',
      note: '輪替碼驗證失敗'
    };
  }

  return { ok: true };
}


/* ======================= 一機一人 ======================= */
/*
 * 防止學生用自己的手機連續幫好幾個朋友簽到。
 * 這是「增加麻煩」而不是「絕對防堵」——清掉瀏覽器資料或用無痕視窗就會拿到新的裝置代碼。
 * 真正的價值是留下軌跡：紀錄表的「裝置」欄會顯示同一台手機送了哪些學號。
 */

function deviceKey(req) {
  return 'dev:' + req.session + ':' + req.deviceId;
}

function checkDevice(req) {
  var max = CONFIG.MAX_STUDENTS_PER_DEVICE;
  if (!max || max < 1) return { ok: true };
  if (!req.session || !req.deviceId) return { ok: true };  // 沒場次或沒裝置代碼就不管

  var seen = PropertiesService.getScriptProperties().getProperty(deviceKey(req));
  if (!seen) return { ok: true };

  var ids = seen.split(',');
  if (ids.indexOf(req.studentId) > -1) return { ok: true };   // 同一人重複送，放行
  if (ids.length < max) return { ok: true };

  return {
    ok: false,
    message: max === 1
      ? '這台裝置這堂課已經幫「' + ids[0] + '」簽到過了，不能再幫其他人簽到。'
      : '這台裝置這堂課已達簽到人數上限（' + max + ' 人）。',
    note: '一機多人：已有 ' + seen
  };
}

function markDevice(req) {
  var max = CONFIG.MAX_STUDENTS_PER_DEVICE;
  if (!max || max < 1) return;
  if (!req.session || !req.deviceId) return;

  var props = PropertiesService.getScriptProperties();
  var key = deviceKey(req);
  var seen = props.getProperty(key);
  var ids = seen ? seen.split(',') : [];
  if (ids.indexOf(req.studentId) > -1) return;
  ids.push(req.studentId);
  props.setProperty(key, ids.join(','));
}


/* ============================ 場次去重 ============================ */
/* 用 CacheService + PropertiesService 記住「這個學號在這一場已經登記過」。 */

function sessionKey(req) {
  return 'done:' + req.mode + ':' + req.session + ':' + req.studentId;
}

function alreadyCounted(req) {
  var key = sessionKey(req);
  if (CacheService.getScriptCache().get(key)) return true;
  return PropertiesService.getScriptProperties().getProperty(key) !== null;
}

function markSession(req) {
  // 只有加分模式需要去重；點名重複掃只是更新時間，不必留紀錄，
  // 避免 Script Properties 整學期無謂膨脹。
  if (!req.session || req.mode === 'attendance') return;
  var key = sessionKey(req);
  CacheService.getScriptCache().put(key, '1', 21600); // 6 小時
  PropertiesService.getScriptProperties().setProperty(key, '1');
}

/** 清掉所有場次紀錄（重複使用同一個 session 名稱前可執行）。 */
function clearSessionMarks() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var n = 0;
  for (var k in all) {
    if (k.indexOf('done:') === 0 || k.indexOf('dev:') === 0) { props.deleteProperty(k); n++; }
  }
  Logger.log('已清除 ' + n + ' 筆場次／裝置紀錄');
}


/* ============================ 共用 ============================ */

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 去掉所有空白（含全形空白 U+3000）以便比對姓名。 */
function squash(s) {
  return String(s).replace(/[\s　]+/g, '');
}

function formatTime(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, CONFIG.TIME_FORMAT);
}

function nowString() { return formatTime(new Date()); }


/* ============================ 安裝 / 維護 ============================ */

/** 匯入 roster.csv 後執行一次：補標題、凍結首列、設定格式。 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  var sheet = getSheet(CONFIG.SHEET_NAME, HEADERS);
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  var last = sheet.getLastRow();
  if (last > 1) {
    var n = last - 1;
    sheet.getRange(2, COL.ID, n, 1).setNumberFormat('@');                    // 學號保持文字
    sheet.getRange(2, COL.ATTENDANCE, n, 1).setNumberFormat(CONFIG.TIME_FORMAT);
    sheet.getRange(2, COL.CLASS_BONUS, n, 2).setNumberFormat('0');
    // 加分欄空白補 0，避免累加時出現空值
    var bonus = sheet.getRange(2, COL.CLASS_BONUS, n, 2);
    var vals = bonus.getValues();
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] === '' || vals[i][0] === null) vals[i][0] = 0;
      if (vals[i][1] === '' || vals[i][1] === null) vals[i][1] = 0;
    }
    bonus.setValues(vals);
  }

  getSheet(CONFIG.LOG_SHEET_NAME, LOG_HEADERS);
  Logger.log('名冊共 ' + Math.max(0, sheet.getLastRow() - 1) + ' 位學生，工作表已就緒。');
}

/** 在編輯器直接執行，模擬三種模式各送一筆，檢查讀寫是否正常。 */
function testAllModes() {
  ['attendance', 'classBonus', 'lectureBonus'].forEach(function(mode) {
    var res = doPost({ postData: { contents: JSON.stringify({
      mode: mode, studentId: 'TEST0001', studentName: '測試同學'
    })}});
    Logger.log(mode + ' → ' + res.getContent());
  });
}
