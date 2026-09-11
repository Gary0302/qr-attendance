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
var LOG_HEADERS = ['送出時間', '模式', '學號', '送出姓名', '名冊姓名', '場次', '分數', '結果', '備註'];

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
    points: points
  };
}


/* ============================ 主要邏輯 ============================ */

function handle(req) {
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
    result.note || (result.status === 'success' ? '' : result.message) || ''
  ]);
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
    if (k.indexOf('done:') === 0) { props.deleteProperty(k); n++; }
  }
  Logger.log('已清除 ' + n + ' 筆場次紀錄');
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
