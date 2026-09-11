/*
 * 全站設定檔 —— 部署後只需要改這個檔案。
 * index.html 與 qr.html 都會讀取這裡的設定。
 */
window.APP_CONFIG = {
  // 【必填】Google Apps Script 部署後取得的「網頁應用程式」網址，結尾是 /exec
  API_URL: 'https://script.google.com/macros/s/請換成你的部署ID/exec',

  // 【選填】前端網頁的正式網址（給 QR 產生器用）。留空會自動使用目前網址。
  SITE_URL: '',

  // 【選填】課程名稱，只會顯示在畫面上。
  COURSE_NAME: '',
};
